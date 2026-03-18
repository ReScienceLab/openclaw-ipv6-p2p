/**
 * P2P peer HTTP server listening on [::]:8099.
 *
 * Trust model:
 *   Layer 1 — Ed25519 signature (universal trust anchor)
 *   Layer 2 — TOFU: agentId -> publicKey binding
 *
 * All source IP filtering has been removed. Trust is established at the
 * application layer via Ed25519 signatures, not at the network layer.
 */
import Fastify, { FastifyInstance } from "fastify"
import { createHash } from "node:crypto"
import * as nacl from "tweetnacl"
import { P2PMessage, Endpoint } from "./types"
import { verifySignature, agentIdFromPublicKey, canonicalize } from "./identity"
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version: PROTOCOL_VERSION } = require("../package.json")
import { tofuVerifyAndCache, tofuReplaceKey, getPeersForExchange, upsertDiscoveredPeer, removePeer, getPeer } from "./peer-db"

const MAX_MESSAGE_AGE_MS = 5 * 60 * 1000 // 5 minutes

export type MessageHandler = (msg: P2PMessage & { verified: boolean }) => void

let server: FastifyInstance | null = null
const _inbox: (P2PMessage & { verified: boolean; receivedAt: number })[] = []
const _handlers: MessageHandler[] = []

// Identity for response signing (set at startup)
let _signingKey: { agentId: string; secretKey: Uint8Array } | null = null

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
  identity?: { agentId: string; publicKey: string; privateKey: string }
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

function computeContentDigest(body: string): string {
  const hash = createHash("sha256").update(Buffer.from(body, "utf8")).digest("base64")
  return `sha-256=:${hash}:`
}

function signResponse(status: number, bodyStr: string): Record<string, string> | null {
  if (!_signingKey) return null
  const ts = new Date().toISOString()
  const kid = "#identity"
  const contentDigest = computeContentDigest(bodyStr)
  const signingInput = canonicalize({
    v: PROTOCOL_VERSION,
    from: _signingKey.agentId,
    kid,
    ts,
    status,
    contentDigest,
  })
  const sig = nacl.sign.detached(
    Buffer.from(JSON.stringify(signingInput)),
    _signingKey.secretKey
  )
  return {
    "X-AgentWorld-Version": PROTOCOL_VERSION,
    "X-AgentWorld-From": _signingKey.agentId,
    "X-AgentWorld-KeyId": kid,
    "X-AgentWorld-Timestamp": ts,
    "Content-Digest": contentDigest,
    "X-AgentWorld-Signature": Buffer.from(sig).toString("base64"),
  }
}

export async function startPeerServer(port: number = 8099, opts?: PeerServerOptions): Promise<void> {
  if (opts?.identity) {
    const privBytes = Buffer.from(opts.identity.privateKey, "base64")
    const fullKey = nacl.sign.keyPair.fromSeed(privBytes)
    _signingKey = { agentId: opts.identity.agentId, secretKey: fullKey.secretKey }
  }

  server = Fastify({ logger: false })

  // Sign all /peer/* JSON responses (P2a — AgentWorld v0.2 response signing)
  server.addHook("onSend", async (_req, reply, payload) => {
    if (!_signingKey || typeof payload !== "string") return payload
    const url = ((_req as any).url ?? "").split("?")[0] as string
    if (!url.startsWith("/peer/")) return payload
    const ct = reply.getHeader("content-type") as string | undefined
    if (!ct || !ct.includes("application/json")) return payload
    const hdrs = signResponse(reply.statusCode, payload)
    if (hdrs) {
      for (const [k, v] of Object.entries(hdrs)) reply.header(k, v)
    }
    return payload
  })

  server.get("/peer/ping", async () => ({ ok: true, ts: Date.now() }))
  server.get("/peer/inbox", async () => _inbox.slice(0, 100))
  server.get("/peer/peers", async () => ({ peers: getPeersForExchange(20) }))

  server.post("/peer/announce", async (req, reply) => {
    const ann = req.body as any

    const { signature, ...signable } = ann
    if (!verifySignature(ann.publicKey, signable as Record<string, unknown>, signature)) {
      return reply.code(403).send({ error: "Invalid announcement signature" })
    }

    const agentId: string = ann.from
    if (!agentId) {
      return reply.code(400).send({ error: "Missing 'from' (agentId)" })
    }

    const knownPeer = getPeer(agentId)
    if (!knownPeer?.publicKey && agentIdFromPublicKey(ann.publicKey) !== agentId) {
      return reply.code(400).send({ error: "agentId does not match publicKey" })
    }

    const endpoints: Endpoint[] = ann.endpoints ?? []

    upsertDiscoveredPeer(agentId, ann.publicKey, {
      alias: ann.alias,
      version: ann.version,
      discoveredVia: agentId,
      source: "gossip",
      endpoints,
      capabilities: ann.capabilities ?? [],
    })

    for (const p of ann.peers ?? []) {
      if (!p.agentId || p.agentId === agentId) continue
      upsertDiscoveredPeer(p.agentId, p.publicKey, {
        alias: p.alias,
        discoveredVia: agentId,
        source: "gossip",
        lastSeen: p.lastSeen,
        endpoints: p.endpoints ?? [],
        capabilities: p.capabilities ?? [],
      })
    }

    console.log(`[p2p] peer-exchange  from=${agentId}  shared=${ann.peers?.length ?? 0} peers`)

    const self = _selfMeta.agentId
      ? { agentId: _selfMeta.agentId, publicKey: _selfMeta.publicKey, alias: _selfMeta.alias, version: _selfMeta.version, endpoints: _selfMeta.endpoints }
      : undefined
    return { ok: true, ...(self ? { self } : {}), peers: getPeersForExchange(20) }
  })

  server.post("/peer/message", async (req, reply) => {
    const raw = req.body as any

    const sigData = canonical(raw)
    if (!verifySignature(raw.publicKey, sigData, raw.signature)) {
      return reply.code(403).send({ error: "Invalid Ed25519 signature" })
    }

    const agentId: string = raw.from
    if (!agentId) {
      return reply.code(400).send({ error: "Missing 'from' (agentId)" })
    }

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

    const entry = { ...msg, verified: true, receivedAt: Date.now() }
    _inbox.unshift(entry)
    if (_inbox.length > 500) _inbox.pop()

    console.log(`[p2p] <- verified  from=${agentId}  event=${msg.event}`)

    _handlers.forEach((h) => h(entry))
    return { ok: true }
  })

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

    if (!verifySignature(oldPublicKeyB64, signable, rot.proofs.signedByOld.signature)) {
      return reply.code(403).send({ error: "Invalid signatureByOldKey" })
    }

    if (!verifySignature(newPublicKeyB64, signable, rot.proofs.signedByNew.signature)) {
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
  _signingKey = null
}

export function getInbox(): typeof _inbox {
  return _inbox
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

  const sigData = canonical(raw)
  if (!verifySignature(raw.publicKey, sigData, raw.signature)) {
    return false
  }

  if (!tofuVerifyAndCache(raw.from, raw.publicKey)) {
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

  const entry = { ...msg, verified: true, receivedAt: Date.now() }
  _inbox.unshift(entry)
  if (_inbox.length > 500) _inbox.pop()

  console.log(`[p2p] <- verified (UDP) from=${raw.from}  event=${msg.event}`)
  _handlers.forEach((h) => h(entry))
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
