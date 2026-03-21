/**
 * P2P peer HTTP server listening on [::]:8099.
 *
 * Trust model:
 *   Layer 1 — Ed25519 signature (universal trust anchor)
 *   Layer 2 — TOFU: agentId -> publicKey binding
 *   Layer 3 — World membership: only co-members can exchange messages
 *
 * All source IP filtering has been removed. Trust is established at the
 * application layer via Ed25519 signatures, not at the network layer.
 */
import Fastify, { FastifyInstance } from "fastify"
import { P2PMessage, Identity, Endpoint } from "./types"
import { agentIdFromPublicKey, verifyHttpRequestHeaders, signHttpResponse as signHttpResponseFn, DOMAIN_SEPARATORS, verifyWithDomainSeparator } from "./identity"
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkgVersion: string = require("../package.json").version
const PROTOCOL_VERSION = pkgVersion.split(".").slice(0, 2).join(".")
import { tofuVerifyAndCache, tofuReplaceKey, getPeersForExchange, upsertDiscoveredPeer, removePeer, getPeer } from "./peer-db"

const MAX_MESSAGE_AGE_MS = 5 * 60 * 1000 // 5 minutes

export type MessageHandler = (msg: P2PMessage & { verified: boolean }) => void

let server: FastifyInstance | null = null
const _handlers: MessageHandler[] = []

let _identity: Identity | null = null

// ── World membership allowlist ───────────────────────────────────────────────
const _worldMembers = new Map<string, Set<string>>()

export function addWorldMembers(worldId: string, memberIds: string[]): void {
  let set = _worldMembers.get(worldId)
  if (!set) {
    set = new Set()
    _worldMembers.set(worldId, set)
  }
  for (const id of memberIds) set.add(id)
}

export function removeWorld(worldId: string): void {
  _worldMembers.delete(worldId)
}

export function isCoMember(agentId: string): boolean {
  for (const members of _worldMembers.values()) {
    if (members.has(agentId)) return true
  }
  return false
}

export function clearWorldMembers(): void {
  _worldMembers.clear()
}

interface SelfMeta {
  agentId?: string
  publicKey?: string
  alias?: string
  version?: string
  endpoints?: Endpoint[]
}
let _selfMeta: SelfMeta = {}

export interface PeerServerOptions {
  /** If true, disables startup delays for tests */
  testMode?: boolean
  /** Identity for response signing (optional) */
  identity?: Identity
  /** When set, incoming messages are dispatched to this handler and world co-member check is skipped (used by World Servers) */
  onMessage?: MessageHandler
}

export function setSelfMeta(meta: SelfMeta): void {
  _selfMeta = meta
  // If we have agentId but no signing key, we can't sign responses without privateKey
}

export function onMessage(handler: MessageHandler): void {
  _handlers.push(handler)
}

function canonical(msg: P2PMessage): Record<string, unknown> {
  return {
    from: msg.from,
    publicKey: msg.publicKey,
    event: msg.event,
    content: msg.content,
    timestamp: msg.timestamp,
  }
}

export async function startPeerServer(port: number = 8099, opts?: PeerServerOptions): Promise<void> {
  if (opts?.identity) {
    _identity = opts.identity
  }

  server = Fastify({ logger: false })

  // Preserve raw body string for Content-Digest verification
  server.decorateRequest("rawBody", "")
  server.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (req, body, done) => {
      try {
        ;(req as any).rawBody = body as string
        done(null, JSON.parse(body as string))
      } catch (err) {
        done(err as Error, undefined)
      }
    }
  )

  // Sign all /peer/* JSON responses
  server.addHook("onSend", async (_req, reply, payload) => {
    if (!_identity || typeof payload !== "string") return payload
    const url = ((_req as any).url ?? "").split("?")[0] as string
    if (!url.startsWith("/peer/")) return payload
    const ct = reply.getHeader("content-type") as string | undefined
    if (!ct || !ct.includes("application/json")) return payload
    const hdrs = signHttpResponseFn(_identity, reply.statusCode, payload)
    for (const [k, v] of Object.entries(hdrs)) reply.header(k, v)
    return payload
  })

  server.get("/peer/ping", async () => ({ ok: true, ts: Date.now() }))

  server.post("/peer/message", async (req, reply) => {
    const raw = req.body as any

    if (!raw?.publicKey || !raw?.from) {
      return reply.code(400).send({ error: "Missing 'from' or 'publicKey'" })
    }

    // Verify X-AgentWorld-* header signature
    const rawBody = (req as any).rawBody as string
    const authority = (req.headers["host"] as string) ?? "localhost"
    const reqPath = req.url.split("?")[0]
    const result = verifyHttpRequestHeaders(
      req.headers as Record<string, string>,
      req.method, reqPath, authority, rawBody, raw.publicKey
    )
    if (!result.ok) return reply.code(403).send({ error: result.error })
    const headerFrom = req.headers["x-agentworld-from"] as string
    if (headerFrom !== raw.from) {
      return reply.code(400).send({ error: "X-AgentWorld-From does not match body 'from'" })
    }

    const agentId: string = raw.from

    const knownPeer = getPeer(agentId)
    if (!knownPeer?.publicKey && agentIdFromPublicKey(raw.publicKey) !== agentId) {
      return reply.code(400).send({ error: "agentId does not match publicKey" })
    }

    if (raw.timestamp && Math.abs(Date.now() - raw.timestamp) > MAX_MESSAGE_AGE_MS) {
      return reply.code(400).send({ error: "Message timestamp too old or too far in the future" })
    }

    if (!tofuVerifyAndCache(agentId, raw.publicKey)) {
      return reply.code(403).send({
        error: `Public key mismatch for ${agentId} — possible key rotation, re-add peer`,
      })
    }

    // World co-member check (skip when onMessage handler is set — world servers handle their own auth)
    if (!opts?.onMessage && !isCoMember(agentId)) {
      return reply.code(403).send({ error: "Not a world co-member" })
    }

    const msg: P2PMessage = {
      from: agentId,
      publicKey: raw.publicKey,
      event: raw.event,
      content: raw.content,
      timestamp: raw.timestamp,
      signature: raw.signature,
    }

    if (msg.event === "leave") {
      removePeer(agentId)
      console.log(`[p2p] <- leave  from=${agentId} — removed from peer table`)
      return { ok: true }
    }

    console.log(`[p2p] <- verified  from=${agentId}  event=${msg.event}`)

    _handlers.forEach((h) => h({ ...msg, verified: true }))
    return { ok: true }
  })

  // TODO: transport-level header signing for /peer/key-rotation is deferred —
  // rotation uses its own dual-signature proof structure (signedByOld + signedByNew)
  server.post("/peer/key-rotation", async (req, reply) => {
    const rot = req.body as any

    if (!rot.oldAgentId || !rot.newAgentId ||
        !rot.oldIdentity?.publicKeyMultibase ||
        !rot.newIdentity?.publicKeyMultibase ||
        !rot.proofs?.signedByOld?.signature || !rot.proofs?.signedByNew?.signature) {
      return reply.code(400).send({ error: "Missing required key rotation fields" })
    }

    if (rot.type !== "agentworld-identity-rotation" || rot.version !== PROTOCOL_VERSION) {
      return reply.code(400).send({ error: `Expected type=agentworld-identity-rotation and version=${PROTOCOL_VERSION}` })
    }

    const agentId: string = rot.oldAgentId

    // Only accept key rotation from known peers or co-members
    if (!getPeer(agentId) && !isCoMember(agentId)) {
      return reply.code(403).send({ error: "Unknown agent — key rotation requires existing relationship" })
    }

    let oldPublicKeyB64: string, newPublicKeyB64: string
    try {
      oldPublicKeyB64 = multibaseToBase64(rot.oldIdentity.publicKeyMultibase)
      newPublicKeyB64 = multibaseToBase64(rot.newIdentity.publicKeyMultibase)
    } catch {
      return reply.code(400).send({ error: "Invalid publicKeyMultibase encoding" })
    }
    const timestamp: number = rot.timestamp

    if (agentIdFromPublicKey(oldPublicKeyB64) !== agentId) {
      return reply.code(400).send({ error: "agentId does not match oldPublicKey" })
    }

    if (timestamp && Math.abs(Date.now() - timestamp) > MAX_MESSAGE_AGE_MS) {
      return reply.code(400).send({ error: "Key rotation timestamp too old or too far in the future" })
    }

    const signable = {
      agentId,
      oldPublicKey: oldPublicKeyB64,
      newPublicKey: newPublicKeyB64,
      timestamp,
    }

    if (!verifyWithDomainSeparator(DOMAIN_SEPARATORS.KEY_ROTATION, oldPublicKeyB64, signable, rot.proofs.signedByOld.signature)) {
      return reply.code(403).send({ error: "Invalid signatureByOldKey" })
    }

    if (!verifyWithDomainSeparator(DOMAIN_SEPARATORS.KEY_ROTATION, newPublicKeyB64, signable, rot.proofs.signedByNew.signature)) {
      return reply.code(403).send({ error: "Invalid signatureByNewKey" })
    }

    // TOFU: clean rotation only — key-loss recovery requires manual re-pairing
    const knownPeer = getPeer(agentId)
    if (knownPeer?.publicKey && knownPeer.publicKey !== oldPublicKeyB64) {
      return reply.code(403).send({ error: "TOFU binding mismatch — key-loss recovery requires manual re-pairing" })
    }

    tofuReplaceKey(agentId, newPublicKeyB64)
    console.log(`[p2p] key-rotation  agentId=${agentId}  newKey=${newPublicKeyB64.slice(0, 16)}...`)

    return { ok: true }
  })

  await server.listen({ port, host: "::" })
  console.log(`[p2p] Peer server listening on [::]:${port}`)
}

export async function stopPeerServer(): Promise<void> {
  if (server) {
    await server.close()
    server = null
  }
  _identity = null
}

/**
 * Process a raw UDP datagram as a P2PMessage.
 * Returns true if the message was valid and handled, false otherwise.
 */
export function handleUdpMessage(data: Buffer, from: string): boolean {
  let raw: any
  try {
    raw = JSON.parse(data.toString("utf-8"))
  } catch {
    return false
  }

  if (!raw || !raw.from || !raw.publicKey || !raw.event || !raw.signature) {
    return false
  }

  const knownPeer = getPeer(raw.from)
  if (!knownPeer?.publicKey && agentIdFromPublicKey(raw.publicKey) !== raw.from) {
    return false
  }

  if (raw.timestamp && Math.abs(Date.now() - raw.timestamp) > MAX_MESSAGE_AGE_MS) {
    return false
  }

  const { signature, ...signable } = raw
  if (!verifyWithDomainSeparator(DOMAIN_SEPARATORS.MESSAGE, raw.publicKey, signable, signature)) {
    return false
  }

  if (!tofuVerifyAndCache(raw.from, raw.publicKey)) {
    return false
  }

  // World co-member check
  if (!isCoMember(raw.from)) {
    return false
  }

  const msg: P2PMessage = {
    from: raw.from,
    publicKey: raw.publicKey,
    event: raw.event,
    content: raw.content,
    timestamp: raw.timestamp,
    signature: raw.signature,
  }

  if (msg.event === "leave") {
    removePeer(raw.from)
    console.log(`[p2p] <- leave (UDP) from=${raw.from}`)
    return true
  }

  console.log(`[p2p] <- verified (UDP) from=${raw.from}  event=${msg.event}`)
  _handlers.forEach((h) => h({ ...msg, verified: true }))
  return true
}

// ── Key rotation helpers ─────────────────────────────────────────────────────

const BASE58_ALPHABET_KR = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

function base58Decode(str: string): Uint8Array {
  const bytes = [0]
  for (const char of str) {
    let carry = BASE58_ALPHABET_KR.indexOf(char)
    if (carry < 0) throw new Error(`Invalid base58 char: ${char}`)
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58
      bytes[j] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  for (const char of str) {
    if (char === "1") bytes.push(0)
    else break
  }
  return new Uint8Array(bytes.reverse())
}

/** Convert a multibase (z<base58btc>) Ed25519 public key to base64. */
function multibaseToBase64(multibase: string): string {
  if (!multibase.startsWith("z")) throw new Error("Unsupported multibase prefix")
  const bytes = base58Decode(multibase.slice(1))
  // Strip 2-byte multicodec prefix (0xed 0x01 for Ed25519 public keys)
  const keyBytes = bytes.length === 34 ? bytes.slice(2) : bytes
  return Buffer.from(keyBytes).toString("base64")
}
