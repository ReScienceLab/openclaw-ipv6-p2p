import type { FastifyInstance } from "fastify"
import { agentIdFromPublicKey, verifySignature } from "./crypto.js"
import type { Identity } from "./types.js"
import type { PeerDb as PeerDbType } from "./peer-db.js"

export interface PeerProtocolOpts {
  identity: Identity
  peerDb: PeerDbType
  /** Extra fields to include in /peer/ping response (evaluated on every request) */
  pingExtra?: Record<string, unknown> | (() => Record<string, unknown>)
  /** Called when a non-peer-protocol message arrives. Return reply body or null to skip. */
  onMessage?: (
    agentId: string,
    event: string,
    content: unknown,
    reply: (body: unknown, statusCode?: number) => void
  ) => Promise<void>
}

/**
 * Register DAP peer protocol routes on a Fastify instance:
 *   GET  /peer/ping
 *   GET  /peer/peers
 *   POST /peer/announce
 *   POST /peer/message
 */
export function registerPeerRoutes(
  fastify: FastifyInstance,
  opts: PeerProtocolOpts
): void {
  const { identity, peerDb, pingExtra, onMessage } = opts

  fastify.get("/peer/ping", async () => ({
    ok: true,
    ts: Date.now(),
    agentId: identity.agentId,
    ...(typeof pingExtra === "function" ? pingExtra() : pingExtra),
  }))

  fastify.get("/peer/peers", async () => ({
    peers: peerDb.getPeersForExchange(),
  }))

  fastify.post("/peer/announce", async (req, reply) => {
    const ann = req.body as Record<string, unknown>
    if (!ann?.publicKey || !ann?.from) {
      return reply.code(400).send({ error: "Invalid announce" })
    }
    const { signature, ...signable } = ann
    if (!verifySignature(ann.publicKey as string, signable, signature as string)) {
      return reply.code(403).send({ error: "Invalid signature" })
    }
    if (agentIdFromPublicKey(ann.publicKey as string) !== ann.from) {
      return reply.code(400).send({ error: "agentId does not match publicKey" })
    }
    peerDb.upsert(ann.from as string, ann.publicKey as string, {
      alias: ann.alias as string,
      endpoints: ann.endpoints as [],
      capabilities: ann.capabilities as [],
    })
    return { peers: peerDb.getPeersForExchange() }
  })

  fastify.post("/peer/message", async (req, reply) => {
    const msg = req.body as Record<string, unknown>
    if (!msg?.publicKey || !msg?.from) {
      return reply.code(400).send({ error: "Invalid message" })
    }
    const { signature, ...signable } = msg
    if (!verifySignature(msg.publicKey as string, signable, signature as string)) {
      return reply.code(403).send({ error: "Invalid signature" })
    }

    const agentId = msg.from as string
    // TOFU: verify agentId ↔ publicKey binding
    const known = peerDb.get(agentId)
    if (known?.publicKey) {
      if (known.publicKey !== msg.publicKey) {
        return reply.code(403).send({ error: "publicKey does not match TOFU binding for this agentId" })
      }
    } else {
      if (agentIdFromPublicKey(msg.publicKey as string) !== agentId) {
        return reply.code(400).send({ error: "agentId does not match publicKey" })
      }
    }

    peerDb.upsert(agentId, msg.publicKey as string, {})

    let content: unknown
    try {
      content = typeof msg.content === "string" ? JSON.parse(msg.content) : msg.content
    } catch {
      content = msg.content
    }

    if (onMessage) {
      let replied = false
      await onMessage(agentId, msg.event as string, content, (body, statusCode) => {
        replied = true
        if (statusCode) reply.code(statusCode)
        reply.send(body)
      })
      if (!replied) return { ok: true }
    } else {
      return { ok: true }
    }
  })
}
