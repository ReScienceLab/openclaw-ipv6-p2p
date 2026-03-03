/**
 * P2P peer HTTP server listening on [::]:8099.
 * Handles incoming messages from other OpenClaw nodes via Yggdrasil.
 *
 * Trust model (ported from agents/peer.py, simplified — no central registry):
 *   1. TCP source IP must be in 200::/8 (Yggdrasil) — network-layer auth
 *   2. from_ygg in body must match TCP source IP — prevent body spoofing
 *   3. Ed25519 signature must be valid — application-layer auth
 *   4. TOFU: first message caches the public key; subsequent must match
 */
import Fastify, { FastifyInstance } from "fastify";
import { P2PMessage, PeerAnnouncement } from "./types";
import { verifySignature } from "./identity";
import { toufuVerifyAndCache, getPeersForExchange, upsertDiscoveredPeer, removePeer } from "./peer-db";

export type MessageHandler = (msg: P2PMessage & { verified: boolean }) => void;

let server: FastifyInstance | null = null;
const _inbox: (P2PMessage & { verified: boolean; receivedAt: number })[] = [];
const _handlers: MessageHandler[] = [];

export function onMessage(handler: MessageHandler): void {
  _handlers.push(handler);
}

/** Build the canonical object that the sender signed (all fields except signature). */
function canonical(msg: P2PMessage): Record<string, unknown> {
  return {
    fromYgg: msg.fromYgg,
    publicKey: msg.publicKey,
    event: msg.event,
    content: msg.content,
    timestamp: msg.timestamp,
  };
}

/** Check whether an IPv6 address is in the Yggdrasil 200::/7 range. */
export function isYggdrasilAddr(addr: string): boolean {
  const clean = addr.replace(/^::ffff:/, "");
  return /^2[0-9a-f]{2}:/i.test(clean);
}

export async function startPeerServer(
  port: number = 8099,
  opts: { testMode?: boolean } = {}
): Promise<void> {
  const testMode = opts.testMode ?? false;
  server = Fastify({ logger: false });

  server.get("/peer/ping", async () => ({ ok: true, ts: Date.now() }));

  server.get("/peer/inbox", async () => _inbox.slice(0, 100));

  // Return our known peer list (for passive discovery)
  server.get("/peer/peers", async () => ({
    peers: getPeersForExchange(20),
  }));

  // Peer exchange / announce endpoint
  server.post<{ Body: PeerAnnouncement }>("/peer/announce", async (req, reply) => {
    const ann = req.body;
    const srcIp = req.socket.remoteAddress ?? "";

    if (!testMode) {
      if (!isYggdrasilAddr(srcIp)) {
        return reply.code(403).send({ error: "Source is not a Yggdrasil address" });
      }
      const normalizedSrc = srcIp.replace(/^::ffff:/, "");
      if (ann.fromYgg !== normalizedSrc) {
        return reply.code(403).send({ error: `fromYgg ${ann.fromYgg} does not match TCP source ${normalizedSrc}` });
      }
    }

    // Verify signature over announcement fields (excluding signature itself)
    const { signature, ...signable } = ann;
    if (!verifySignature(ann.publicKey, signable as Record<string, unknown>, signature)) {
      return reply.code(403).send({ error: "Invalid announcement signature" });
    }
    const _peers = ann.peers;

    // TOFU: record the announcer
    upsertDiscoveredPeer(ann.fromYgg, ann.publicKey, {
      alias: ann.alias,
      discoveredVia: ann.fromYgg,
      source: "gossip",
    });

    // Absorb the peers they shared — preserve provenance timestamp
    for (const p of ann.peers ?? []) {
      if (p.yggAddr === ann.fromYgg) continue; // skip self-referential entries
      upsertDiscoveredPeer(p.yggAddr, p.publicKey, {
        alias: p.alias,
        discoveredVia: ann.fromYgg,
        source: "gossip",
        lastSeen: p.lastSeen,
      });
    }

    console.log(
      `[p2p] ↔ peer-exchange  from=${ann.fromYgg.slice(0, 20)}...  shared=${ann.peers?.length ?? 0} peers`
    );

    // Return our own peer list
    return { ok: true, peers: getPeersForExchange(20) };
  });

  server.post<{ Body: P2PMessage }>("/peer/message", async (req, reply) => {
    const msg = req.body;
    const srcIp = req.socket.remoteAddress ?? "";

    if (!testMode) {
      // Step 1: Verify source is Yggdrasil
      if (!isYggdrasilAddr(srcIp)) {
        return reply.code(403).send({ error: "Source is not a Yggdrasil address (200::/8 required)" });
      }

      // Step 2: from_ygg must match TCP source IP
      const normalizedSrc = srcIp.replace(/^::ffff:/, "");
      if (msg.fromYgg !== normalizedSrc) {
        return reply.code(403).send({
          error: `from_ygg ${msg.fromYgg} does not match TCP source ${normalizedSrc}`,
        });
      }
    }

    // Step 3: Ed25519 signature
    if (!verifySignature(msg.publicKey, canonical(msg), msg.signature)) {
      return reply.code(403).send({ error: "Invalid Ed25519 signature" });
    }

    // Step 4: TOFU cache
    if (!toufuVerifyAndCache(msg.fromYgg, msg.publicKey)) {
      return reply.code(403).send({
        error: `Public key mismatch for ${msg.fromYgg} — possible key rotation, re-add peer`,
      });
    }

    // Signed tombstone: peer is gracefully leaving — remove from routing table
    if (msg.event === "leave") {
      removePeer(msg.fromYgg);
      console.log(`[p2p] ← leave  from=${msg.fromYgg.slice(0, 20)}... — removed from peer table`);
      return { ok: true };
    }

    const entry = { ...msg, verified: true, receivedAt: Date.now() };
    _inbox.unshift(entry);
    if (_inbox.length > 500) _inbox.pop();

    console.log(
      `[p2p] ← verified  from=${msg.fromYgg.slice(0, 20)}...  event=${msg.event}`
    );

    _handlers.forEach((h) => h(entry));
    return { ok: true };
  });

  await server.listen({ port, host: "::" });
  console.log(`[p2p] Peer server listening on [::]:${port}${testMode ? " (test mode)" : ""}`);
}

export async function stopPeerServer(): Promise<void> {
  if (server) {
    await server.close();
    server = null;
  }
}

export function getInbox(): typeof _inbox {
  return _inbox;
}
