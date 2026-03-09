/**
 * P2P peer HTTP server listening on [::]:8099.
 *
 * Trust model (transport-agnostic):
 *   Layer 1 — Transport security (TLS/Yggdrasil/WireGuard — handled by transport)
 *   Layer 2 — Ed25519 signature (universal trust anchor)
 *   Layer 3 — TOFU: agentId -> publicKey binding
 */
import Fastify, { FastifyInstance } from "fastify"
import { P2PMessage, Endpoint } from "./types"
import { verifySignature, agentIdFromPublicKey } from "./identity"
import { tofuVerifyAndCache, getPeersForExchange, upsertDiscoveredPeer, removePeer } from "./peer-db"

export type MessageHandler = (msg: P2PMessage & { verified: boolean }) => void

let server: FastifyInstance | null = null
const _inbox: (P2PMessage & { verified: boolean; receivedAt: number })[] = []
const _handlers: MessageHandler[] = []

interface SelfMeta {
  agentId?: string
  publicKey?: string
  alias?: string
  version?: string
  endpoints?: Endpoint[]
}
let _selfMeta: SelfMeta = {}

export function setSelfMeta(meta: SelfMeta): void {
  _selfMeta = meta
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

export function isYggdrasilAddr(addr: string): boolean {
  const clean = addr.replace(/^::ffff:/, "")
  return /^2[0-9a-f]{2}:/i.test(clean)
}

export async function startPeerServer(
  port: number = 8099,
  opts: { testMode?: boolean; yggdrasilActive?: boolean } = {}
): Promise<void> {
  const testMode = opts.testMode ?? false
  const yggActive = opts.yggdrasilActive ?? false
  server = Fastify({ logger: false })

  server.get("/peer/ping", async () => ({ ok: true, ts: Date.now() }))
  server.get("/peer/inbox", async () => _inbox.slice(0, 100))
  server.get("/peer/peers", async () => ({ peers: getPeersForExchange(20) }))

  server.post("/peer/announce", async (req, reply) => {
    const ann = req.body as any
    const srcIp = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "")

    // Network-layer gate: when Yggdrasil is active, only accept from 200::/7
    if (yggActive && !testMode && !isYggdrasilAddr(srcIp)) {
      return reply.code(403).send({ error: `Non-Yggdrasil source ${srcIp} rejected` })
    }

    const { signature, ...signable } = ann
    if (!verifySignature(ann.publicKey, signable as Record<string, unknown>, signature)) {
      return reply.code(403).send({ error: "Invalid announcement signature" })
    }

    const agentId: string = ann.from
    if (!agentId) {
      return reply.code(400).send({ error: "Missing 'from' (agentId)" })
    }

    if (agentIdFromPublicKey(ann.publicKey) !== agentId) {
      return reply.code(400).send({ error: "agentId does not match publicKey" })
    }

    const endpoints: Endpoint[] = ann.endpoints ?? []

    upsertDiscoveredPeer(agentId, ann.publicKey, {
      alias: ann.alias,
      version: ann.version,
      discoveredVia: agentId,
      source: "gossip",
      endpoints,
    })

    for (const p of ann.peers ?? []) {
      if (!p.agentId || p.agentId === agentId) continue
      upsertDiscoveredPeer(p.agentId, p.publicKey, {
        alias: p.alias,
        discoveredVia: agentId,
        source: "gossip",
        lastSeen: p.lastSeen,
        endpoints: p.endpoints ?? [],
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
    const srcIp = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "")

    if (yggActive && !testMode && !isYggdrasilAddr(srcIp)) {
      return reply.code(403).send({ error: `Non-Yggdrasil source ${srcIp} rejected` })
    }

    const sigData = canonical(raw)
    if (!verifySignature(raw.publicKey, sigData, raw.signature)) {
      return reply.code(403).send({ error: "Invalid Ed25519 signature" })
    }

    const agentId: string = raw.from
    if (!agentId) {
      return reply.code(400).send({ error: "Missing 'from' (agentId)" })
    }

    if (agentIdFromPublicKey(raw.publicKey) !== agentId) {
      return reply.code(400).send({ error: "agentId does not match publicKey" })
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

  await server.listen({ port, host: "::" })
  console.log(`[p2p] Peer server listening on [::]:${port}${testMode ? " (test mode)" : ""}`)
}

export async function stopPeerServer(): Promise<void> {
  if (server) {
    await server.close()
    server = null
  }
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

  if (agentIdFromPublicKey(raw.publicKey) !== raw.from) {
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
