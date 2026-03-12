/**
 * DAP World Agent — standalone deployable world server.
 * No OpenClaw dependency. Runs on plain HTTP/TCP.
 *
 * Endpoints:
 *   GET  /peer/ping        — health check
 *   GET  /peer/peers       — known DAP peers
 *   POST /peer/announce    — accept signed peer announcement
 *   POST /peer/message     — receive world.join / world.action / world.leave
 *   GET  /world/state      — current world snapshot (HTTP poll)
 *
 * Env:
 *   WORLD_ID      — unique world identifier, e.g. "pixel-city" (required)
 *   WORLD_NAME    — human-readable name, e.g. "Pixel City"
 *   WORLD_THEME   — theme tag, e.g. "city" | "dungeon" | "space"
 *   PEER_PORT     — DAP HTTP port (default 8099)
 *   DATA_DIR      — persistence directory (default /data)
 *   BOOTSTRAP_URL — URL of bootstrap.json (default GitHub Pages)
 *   BROADCAST_INTERVAL_MS — how often to broadcast world.state (default 5000)
 */
import Fastify from "fastify";
import nacl from "tweetnacl";
import fs from "fs";
import path from "path";
import crypto from "node:crypto";

const WORLD_ID = process.env.WORLD_ID;
if (!WORLD_ID) { console.error("[world] WORLD_ID env var is required"); process.exit(1); }

const WORLD_NAME = process.env.WORLD_NAME ?? `World (${WORLD_ID})`;
const WORLD_THEME = process.env.WORLD_THEME ?? "default";
const PORT = parseInt(process.env.PEER_PORT ?? "8099");
const DATA_DIR = process.env.DATA_DIR ?? "/data";
const BOOTSTRAP_URL = process.env.BOOTSTRAP_URL ?? "https://resciencelab.github.io/DAP/bootstrap.json";
const BROADCAST_INTERVAL_MS = parseInt(process.env.BROADCAST_INTERVAL_MS ?? "5000");
const MAX_EVENTS = 100;
const MAX_PEERS = 200;
const WORLD_WIDTH = 32;
const WORLD_HEIGHT = 32;

// ---------------------------------------------------------------------------
// Crypto helpers (mirrors bootstrap/server.mjs)
// ---------------------------------------------------------------------------

function agentIdFromPublicKey(publicKeyB64) {
  return crypto.createHash("sha256").update(Buffer.from(publicKeyB64, "base64")).digest("hex").slice(0, 32);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted = {};
    for (const k of Object.keys(value).sort()) sorted[k] = canonicalize(value[k]);
    return sorted;
  }
  return value;
}

function verifySignature(publicKeyB64, obj, signatureB64) {
  try {
    const pubKey = Buffer.from(publicKeyB64, "base64");
    const sig = Buffer.from(signatureB64, "base64");
    const msg = Buffer.from(JSON.stringify(canonicalize(obj)));
    return nacl.sign.detached.verify(msg, sig, pubKey);
  } catch { return false; }
}

function signPayload(payload, secretKey) {
  const sig = nacl.sign.detached(Buffer.from(JSON.stringify(canonicalize(payload))), secretKey);
  return Buffer.from(sig).toString("base64");
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------
fs.mkdirSync(DATA_DIR, { recursive: true });

const idFile = path.join(DATA_DIR, "world-identity.json");
let selfKeypair;
if (fs.existsSync(idFile)) {
  const saved = JSON.parse(fs.readFileSync(idFile, "utf8"));
  selfKeypair = nacl.sign.keyPair.fromSeed(Buffer.from(saved.seed, "base64"));
} else {
  const seed = nacl.randomBytes(32);
  selfKeypair = nacl.sign.keyPair.fromSeed(seed);
  fs.writeFileSync(idFile, JSON.stringify({
    seed: Buffer.from(seed).toString("base64"),
    publicKey: Buffer.from(selfKeypair.publicKey).toString("base64"),
  }, null, 2));
}
const selfPubB64 = Buffer.from(selfKeypair.publicKey).toString("base64");
const selfAgentId = agentIdFromPublicKey(selfPubB64);

console.log(`[world] agentId=${selfAgentId} world=${WORLD_ID} name="${WORLD_NAME}"`);

// ---------------------------------------------------------------------------
// Peer DB (known DAP peers, including Gateway)
// ---------------------------------------------------------------------------
const peers = new Map(); // agentId -> { agentId, publicKey, alias, endpoints, lastSeen }

function upsertPeer(agentId, publicKey, opts = {}) {
  const now = Date.now();
  const existing = peers.get(agentId);
  peers.set(agentId, {
    agentId,
    publicKey: publicKey || existing?.publicKey || "",
    alias: opts.alias ?? existing?.alias ?? "",
    endpoints: opts.endpoints ?? existing?.endpoints ?? [],
    capabilities: opts.capabilities ?? existing?.capabilities ?? [],
    lastSeen: now,
  });
  if (peers.size > MAX_PEERS) {
    const oldest = [...peers.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
    peers.delete(oldest.agentId);
  }
}

function getPeersForExchange(limit = 50) {
  return [...peers.values()]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, limit)
    .map(({ agentId, publicKey, alias, endpoints, capabilities, lastSeen }) => ({
      agentId, publicKey, alias, endpoints: endpoints ?? [], capabilities: capabilities ?? [], lastSeen,
    }));
}

// ---------------------------------------------------------------------------
// World state
// ---------------------------------------------------------------------------

// agents in world: agentId -> { agentId, alias, x, y, joinedAt, lastSeen }
const worldAgents = new Map();

// recent events ring buffer
const events = [];

function addEvent(type, data) {
  const ev = { type, ...data, ts: Date.now() };
  events.push(ev);
  if (events.length > MAX_EVENTS) events.shift();
  return ev;
}

function randomPos() {
  return {
    x: Math.floor(Math.random() * WORLD_WIDTH),
    y: Math.floor(Math.random() * WORLD_HEIGHT),
  };
}

function getWorldSnapshot() {
  return {
    worldId: WORLD_ID,
    worldName: WORLD_NAME,
    theme: WORLD_THEME,
    agentCount: worldAgents.size,
    agents: [...worldAgents.values()],
    recentEvents: events.slice(-20),
    ts: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Outbound messaging (send world.state broadcasts to Gateway peers)
// ---------------------------------------------------------------------------

async function sendMessage(endpoints, event, content) {
  if (!endpoints?.length) return;
  const sorted = [...endpoints].sort((a, b) => a.priority - b.priority);
  const payload = {
    from: selfAgentId,
    publicKey: selfPubB64,
    event,
    content: typeof content === "string" ? content : JSON.stringify(content),
    timestamp: Date.now(),
  };
  payload.signature = signPayload(payload, selfKeypair.secretKey);

  for (const ep of sorted) {
    try {
      const addr = ep.address;
      const port = ep.port ?? 8099;
      const isIpv6 = addr.includes(":") && !addr.includes(".");
      const url = isIpv6 ? `http://[${addr}]:${port}/peer/message` : `http://${addr}:${port}/peer/message`;
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8_000),
      });
      return;
    } catch {}
  }
}

async function broadcastWorldState() {
  const snapshot = getWorldSnapshot();
  const knownPeers = [...peers.values()].filter((p) => p.endpoints?.length);
  await Promise.allSettled(
    knownPeers.map((p) => sendMessage(p.endpoints, "world.state", snapshot))
  );
}

// ---------------------------------------------------------------------------
// Announce to bootstrap nodes
// ---------------------------------------------------------------------------

async function fetchBootstrapNodes() {
  try {
    const resp = await fetch(BOOTSTRAP_URL, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.bootstrap_nodes ?? []).filter((n) => n.addr).map((n) => ({
      addr: n.addr, httpPort: n.httpPort ?? 8099,
    }));
  } catch { return []; }
}

async function announceToNode(addr, httpPort) {
  const isIpv6 = addr.includes(":") && !addr.includes(".");
  const url = isIpv6 ? `http://[${addr}]:${httpPort}/peer/announce` : `http://${addr}:${httpPort}/peer/announce`;
  const payload = {
    from: selfAgentId,
    publicKey: selfPubB64,
    alias: WORLD_NAME,
    version: "1.0.0",
    endpoints: [{ transport: "tcp", address: addr, port: httpPort, priority: 1, ttl: 3600 }],
    capabilities: [`world:${WORLD_ID}`],
    timestamp: Date.now(),
  };
  payload.signature = signPayload(payload, selfKeypair.secretKey);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    for (const peer of data.peers ?? []) {
      if (peer.agentId && peer.agentId !== selfAgentId) {
        upsertPeer(peer.agentId, peer.publicKey, {
          alias: peer.alias, endpoints: peer.endpoints, capabilities: peer.capabilities,
        });
      }
    }
    console.log(`[world] Announced to ${addr}:${httpPort}, got ${data.peers?.length ?? 0} peers`);
  } catch (e) {
    console.warn(`[world] Could not reach bootstrap ${addr}:${httpPort}: ${e.message}`);
  }
}

async function bootstrapDiscovery() {
  const nodes = await fetchBootstrapNodes();
  if (!nodes.length) { console.warn("[world] No bootstrap nodes found"); return; }
  await Promise.allSettled(nodes.map((n) => announceToNode(n.addr, n.httpPort)));
}

// ---------------------------------------------------------------------------
// Fastify server
// ---------------------------------------------------------------------------

const fastify = Fastify({ logger: false });

fastify.get("/peer/ping", async () => ({
  ok: true, ts: Date.now(), worldId: WORLD_ID, worldName: WORLD_NAME,
  agents: worldAgents.size,
}));

fastify.get("/peer/peers", async () => ({
  peers: getPeersForExchange(),
}));

fastify.get("/world/state", async () => getWorldSnapshot());

fastify.post("/peer/announce", async (req, reply) => {
  const ann = req.body;
  const { signature, ...signable } = ann;
  if (!verifySignature(ann.publicKey, signable, signature)) {
    return reply.code(403).send({ error: "Invalid signature" });
  }
  const agentId = ann.from;
  if (!agentId) return reply.code(400).send({ error: "Missing from" });
  if (agentIdFromPublicKey(ann.publicKey) !== agentId) {
    return reply.code(400).send({ error: "agentId does not match publicKey" });
  }
  upsertPeer(agentId, ann.publicKey, {
    alias: ann.alias, endpoints: ann.endpoints, capabilities: ann.capabilities,
  });
  return { peers: getPeersForExchange() };
});

fastify.post("/peer/message", async (req, reply) => {
  const msg = req.body;
  const { signature, ...signable } = msg;

  if (!verifySignature(msg.publicKey, signable, signature)) {
    return reply.code(403).send({ error: "Invalid signature" });
  }
  const agentId = msg.from;
  if (!agentId) return reply.code(400).send({ error: "Missing from" });

  // Update peer record on contact
  upsertPeer(agentId, msg.publicKey, {});

  let data = {};
  try { data = typeof msg.content === "string" ? JSON.parse(msg.content) : msg.content; } catch {}

  switch (msg.event) {
    case "world.join": {
      const pos = randomPos();
      worldAgents.set(agentId, {
        agentId,
        alias: data.alias ?? msg.alias ?? agentId.slice(0, 8),
        x: pos.x, y: pos.y,
        joinedAt: Date.now(),
        lastSeen: Date.now(),
      });
      addEvent("join", { agentId, alias: worldAgents.get(agentId).alias, worldId: WORLD_ID });
      console.log(`[world] ${agentId.slice(0, 8)} joined — ${worldAgents.size} agents`);
      return { ok: true, worldId: WORLD_ID, pos };
    }

    case "world.leave": {
      const agent = worldAgents.get(agentId);
      if (agent) {
        worldAgents.delete(agentId);
        addEvent("leave", { agentId, alias: agent.alias, worldId: WORLD_ID });
        console.log(`[world] ${agentId.slice(0, 8)} left — ${worldAgents.size} agents`);
      }
      return { ok: true };
    }

    case "world.action": {
      const agent = worldAgents.get(agentId);
      if (!agent) return reply.code(400).send({ error: "Agent not in world — join first" });
      agent.lastSeen = Date.now();
      if (data.action === "move" && data.x != null && data.y != null) {
        agent.x = Math.max(0, Math.min(WORLD_WIDTH - 1, Math.floor(data.x)));
        agent.y = Math.max(0, Math.min(WORLD_HEIGHT - 1, Math.floor(data.y)));
      }
      addEvent("action", { agentId, alias: agent.alias, action: data.action, payload: data, worldId: WORLD_ID });
      return { ok: true };
    }

    default:
      return { ok: true };
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

await fastify.listen({ port: PORT, host: "::" });
console.log(`[world] Listening on [::]:${PORT}  world=${WORLD_ID}`);

// Bootstrap discovery after 3s
setTimeout(bootstrapDiscovery, 3_000);
// Re-announce every 10min
setInterval(bootstrapDiscovery, 10 * 60 * 1000);

// Broadcast world state periodically
setInterval(broadcastWorldState, BROADCAST_INTERVAL_MS);

// Evict agents idle > 5min
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [id, agent] of worldAgents) {
    if (agent.lastSeen < cutoff) {
      worldAgents.delete(id);
      addEvent("leave", { agentId: id, alias: agent.alias, reason: "idle", worldId: WORLD_ID });
    }
  }
}, 60_000);
