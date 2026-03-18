/**
 * DAP Gateway — stateless portal + WebSocket bridge.
 * No OpenClaw dependency. Runs on plain HTTP/TCP.
 *
 * HTTP Endpoints:
 *   GET  /health          — health check
 *   GET  /worlds          — list discovered world:* peers on DAP network
 *   GET  /agents          — list all known DAP peers
 *   GET  /world/:worldId  — info about a specific world
 *
 * WebSocket:
 *   WS   /ws?world=<worldId>  — subscribe to a world's real-time events
 *       Client → server: { type: "action", action: "move", x, y }
 *                        { type: "join", alias: "..." }
 *                        { type: "leave" }
 *       Server → client: { type: "world.state", ... }
 *                        { type: "error", message: "..." }
 *
 * Env:
 *   PEER_PORT         — DAP peer HTTP port (default 8099)
 *   HTTP_PORT         — gateway public HTTP port (default 8100)
 *   PUBLIC_ADDR       — own public IP/hostname for DAP announce
 *   DATA_DIR          — identity persistence (default /data)
 *   BOOTSTRAP_URL     — bootstrap node list (default GitHub Pages)
 *   DISCOVERY_INTERVAL_MS — how often to re-discover worlds (default 60000)
 */
import Fastify from "fastify";
import websocketPlugin from "@fastify/websocket";
import cors from "@fastify/cors";
import nacl from "tweetnacl";
import {
  agentIdFromPublicKey,
  canonicalize,
  verifySignature,
  signPayload,
  signHttpRequest,
  verifyHttpRequestHeaders,
  loadOrCreateIdentity,
  buildSignedAgentCard,
} from "@resciencelab/agent-world-sdk";

const PEER_PORT = parseInt(process.env.PEER_PORT ?? "8099");
const HTTP_PORT = parseInt(process.env.HTTP_PORT ?? "8100");
const PUBLIC_ADDR = process.env.PUBLIC_ADDR ?? null;
const PUBLIC_URL = process.env.PUBLIC_URL ?? null; // e.g. https://gateway.example.com
const DATA_DIR = process.env.DATA_DIR ?? "/data";
const BOOTSTRAP_URL = process.env.BOOTSTRAP_URL ?? "https://resciencelab.github.io/DAP/bootstrap.json";
const DISCOVERY_INTERVAL_MS = parseInt(process.env.DISCOVERY_INTERVAL_MS ?? "60000");
const STALE_TTL_MS = parseInt(process.env.STALE_TTL_MS ?? String(30 * 60 * 1000)); // 30 min
const MAX_PEERS = 500;

// ---------------------------------------------------------------------------
// Identity (loaded via agent-world-sdk)
// ---------------------------------------------------------------------------

const identity = loadOrCreateIdentity(DATA_DIR, "gateway-identity");
const selfPubB64 = identity.pubB64;
const selfAgentId = identity.agentId;

console.log(`[gateway] agentId=${selfAgentId}`);

// ---------------------------------------------------------------------------
// Peer DB
// ---------------------------------------------------------------------------
const peers = new Map(); // agentId -> PeerRecord

function upsertPeer(agentId, publicKey, opts = {}) {
  const now = Date.now();
  const existing = peers.get(agentId);
  // For gossipped peers, preserve the original lastSeen from the sender
  // Only use Date.now() for direct contacts (no lastSeen provided)
  const lastSeen = opts.lastSeen
    ? Math.max(existing?.lastSeen ?? 0, opts.lastSeen)
    : now;
  peers.set(agentId, {
    agentId,
    publicKey: publicKey || existing?.publicKey || "",
    alias: opts.alias ?? existing?.alias ?? "",
    endpoints: opts.endpoints ?? existing?.endpoints ?? [],
    capabilities: opts.capabilities ?? existing?.capabilities ?? [],
    lastSeen,
  });
  if (peers.size > MAX_PEERS) {
    const oldest = [...peers.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
    peers.delete(oldest.agentId);
  }
}

function pruneStale(ttl = STALE_TTL_MS) {
  const cutoff = Date.now() - ttl;
  let pruned = 0;
  for (const [id, p] of peers) {
    if (p.lastSeen < cutoff) { peers.delete(id); pruned++; }
  }
  if (pruned > 0) console.log(`[gateway] Pruned ${pruned} stale peer(s) (TTL ${Math.round(ttl / 60000)}min)`);
}

function getPeersForExchange(limit = 50) {
  return [...peers.values()]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, limit)
    .map(({ agentId, publicKey, alias, endpoints, capabilities, lastSeen }) => ({
      agentId, publicKey, alias, endpoints: endpoints ?? [], capabilities: capabilities ?? [], lastSeen,
    }));
}

function findByCapability(cap) {
  const isPrefix = cap.endsWith(":");
  return [...peers.values()].filter((p) =>
    p.capabilities?.some((c) => isPrefix ? c.startsWith(cap) : c === cap)
  ).sort((a, b) => b.lastSeen - a.lastSeen);
}

// ---------------------------------------------------------------------------
// WebSocket subscriptions: worldId -> Set<WebSocket>
// ---------------------------------------------------------------------------
const worldSubs = new Map(); // worldId -> Set<ws>
// browser session agentIds: sessionId -> { agentId, publicKey, secretKey, alias, worldId }
const sessions = new Map();

function broadcast(worldId, data) {
  const subs = worldSubs.get(worldId);
  if (!subs) return;
  const msg = JSON.stringify(data);
  for (const ws of subs) {
    try { ws.send(msg); } catch {}
  }
}

function subscribe(worldId, ws) {
  if (!worldSubs.has(worldId)) worldSubs.set(worldId, new Set());
  worldSubs.get(worldId).add(ws);
}

function unsubscribe(worldId, ws) {
  worldSubs.get(worldId)?.delete(ws);
  if (worldSubs.get(worldId)?.size === 0) worldSubs.delete(worldId);
}

// ---------------------------------------------------------------------------
// Outbound DAP messaging (gateway → world agent)
// ---------------------------------------------------------------------------

async function sendToWorld(worldId, event, content) {
  const world = findByCapability(`world:${worldId}`)[0];
  if (!world?.endpoints?.length) {
    console.warn(`[gateway] No reachable endpoints for world:${worldId}`);
    return { ok: false, error: "World agent not reachable" };
  }
  const sorted = [...world.endpoints].sort((a, b) => a.priority - b.priority);
  const payload = {
    from: selfAgentId,
    publicKey: selfPubB64,
    event,
    content: typeof content === "string" ? content : JSON.stringify(content),
    timestamp: Date.now(),
  };
  payload.signature = signPayload(payload, identity.secretKey);

  for (const ep of sorted) {
    try {
      const addr = ep.address;
      const port = ep.port ?? PEER_PORT;
      const isIpv6 = addr.includes(":") && !addr.includes(".");
      const url = isIpv6 ? `http://[${addr}]:${port}/peer/message` : `http://${addr}:${port}/peer/message`;
      const body = JSON.stringify(canonicalize(payload));
      const urlObj = new URL(url);
      const awHeaders = signHttpRequest(identity, "POST", urlObj.host, "/peer/message", body);
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...awHeaders },
        body,
        signal: AbortSignal.timeout(8_000),
      });
      const data = await resp.json();
      return { ok: resp.ok, ...data };
    } catch {}
  }
  return { ok: false, error: "All world agent endpoints unreachable" };
}

// ---------------------------------------------------------------------------
// Bootstrap discovery
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
  const selfEndpoints = PUBLIC_ADDR
    ? [{ transport: "tcp", address: PUBLIC_ADDR, port: PEER_PORT, priority: 1, ttl: 3600 }]
    : [];
  const payload = {
    from: selfAgentId,
    publicKey: selfPubB64,
    alias: "DAP Gateway",
    version: "1.0.0",
    endpoints: selfEndpoints,
    capabilities: ["gateway"],
    timestamp: Date.now(),
  };
  payload.signature = signPayload(payload, identity.secretKey);
  try {
    const body = JSON.stringify(canonicalize(payload));
    const urlObj = new URL(url);
    const awHeaders = signHttpRequest(identity, "POST", urlObj.host, "/peer/announce", body);
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...awHeaders },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    for (const peer of data.peers ?? []) {
      if (peer.agentId && peer.agentId !== selfAgentId) {
        upsertPeer(peer.agentId, peer.publicKey, {
          alias: peer.alias, endpoints: peer.endpoints, capabilities: peer.capabilities,
          lastSeen: peer.lastSeen,
        });
      }
    }
    console.log(`[gateway] Announced to ${addr}:${httpPort}, got ${data.peers?.length ?? 0} peers`);
  } catch (e) {
    console.warn(`[gateway] Could not reach bootstrap ${addr}:${httpPort}: ${e.message}`);
  }
}

function worldIdFromPeer(peer) {
  const cap = peer.capabilities?.find((c) => c.startsWith("world:"));
  return cap ? cap.slice("world:".length) : null;
}

async function probeWorldReachable(peer) {
  if (!peer.endpoints?.length) return false;
  const expectedWorldId = worldIdFromPeer(peer);
  for (const ep of peer.endpoints) {
    try {
      const addr = ep.address;
      const port = ep.port ?? PEER_PORT;
      const isIpv6 = addr.includes(":") && !addr.includes(".");
      const url = isIpv6 ? `http://[${addr}]:${port}/peer/ping` : `http://${addr}:${port}/peer/ping`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        // World agents must return worldId in ping response
        if (expectedWorldId) {
          if (!data.worldId) return false; // not a world agent (e.g. gateway)
          if (data.worldId !== expectedWorldId) return false; // port collision
        }
        return true;
      }
    } catch {}
  }
  return false;
}

async function discoverWorlds() {
  const nodes = await fetchBootstrapNodes();
  if (!nodes.length) { console.warn("[gateway] No bootstrap nodes found"); return; }
  await Promise.allSettled(nodes.map((n) => announceToNode(n.addr, n.httpPort)));

  // Probe world endpoints and remove unreachable ones
  const worlds = findByCapability("world:");
  const results = await Promise.allSettled(worlds.map((w) => probeWorldReachable(w)));
  let removed = 0;
  for (let i = 0; i < worlds.length; i++) {
    const reachable = results[i].status === "fulfilled" && results[i].value;
    if (!reachable) {
      peers.delete(worlds[i].agentId);
      removed++;
    }
  }
  const remaining = findByCapability("world:");
  console.log(`[gateway] Discovered ${worlds.length} world(s), ${removed} unreachable removed, ${remaining.length} live, ${peers.size} peers total`);
}

// ---------------------------------------------------------------------------
// DAP peer server (receive world.state broadcasts from World Agents)
// ---------------------------------------------------------------------------

async function startPeerListener() {
  const peerServer = Fastify({ logger: false });

  // Preserve raw request body for Content-Digest verification
  peerServer.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    try {
      req.rawBody = body;
      done(null, JSON.parse(body));
    } catch (err) {
      done(err, undefined);
    }
  });

  peerServer.get("/peer/ping", async () => ({ ok: true, ts: Date.now(), role: "gateway" }));
  peerServer.get("/peer/peers", async () => ({ peers: getPeersForExchange() }));

  peerServer.post("/peer/announce", async (req, reply) => {
    const ann = req.body;
    if (!ann?.publicKey || !ann?.from) return reply.code(400).send({ error: "Invalid announce" });

    const awSig = req.headers["x-agentworld-signature"];
    if (awSig) {
      const authority = req.headers["host"] ?? "localhost";
      const result = verifyHttpRequestHeaders(req.headers, req.method, req.url, authority, req.rawBody, ann.publicKey);
      if (!result.ok) return reply.code(403).send({ error: result.error });
    } else {
      const { signature, ...signable } = ann;
      if (!verifySignature(ann.publicKey, signable, signature)) {
        return reply.code(403).send({ error: "Invalid signature" });
      }
    }

    if (agentIdFromPublicKey(ann.publicKey) !== ann.from) {
      return reply.code(400).send({ error: "agentId mismatch" });
    }
    upsertPeer(ann.from, ann.publicKey, {
      alias: ann.alias, endpoints: ann.endpoints, capabilities: ann.capabilities,
    });
    return { ok: true, peers: getPeersForExchange(20) };
  });

  peerServer.post("/peer/message", async (req, reply) => {
    const msg = req.body;
    if (!msg?.publicKey || !msg?.from) return reply.code(400).send({ error: "Invalid message" });

    const awSig = req.headers["x-agentworld-signature"];
    if (awSig) {
      const authority = req.headers["host"] ?? "localhost";
      const result = verifyHttpRequestHeaders(req.headers, req.method, req.url, authority, req.rawBody, msg.publicKey);
      if (!result.ok) return reply.code(403).send({ error: result.error });
    } else {
      const { signature, ...signable } = msg;
      if (!verifySignature(msg.publicKey, signable, signature)) {
        return reply.code(403).send({ error: "Invalid signature" });
      }
    }

    // Handle world.state broadcasts from World Agents
    if (msg.event === "world.state") {
      let state;
      try { state = typeof msg.content === "string" ? JSON.parse(msg.content) : msg.content; } catch { return { ok: true }; }
      const worldId = state.worldId;
      if (worldId) broadcast(worldId, { type: "world.state", ...state });
    }

    upsertPeer(msg.from, msg.publicKey, {});
    return { ok: true };
  });

  await peerServer.listen({ port: PEER_PORT, host: "::" });
  console.log(`[gateway] DAP peer listener on [::]:${PEER_PORT}`);
}

// ---------------------------------------------------------------------------
// Public HTTP + WebSocket server
// ---------------------------------------------------------------------------

const app = Fastify({ logger: false });
await app.register(cors, { origin: true });
await app.register(websocketPlugin);

app.get("/health", async () => ({
  ok: true, ts: Date.now(), agentId: selfAgentId,
  peers: peers.size, worlds: findByCapability("world:").length,
}));

// Agent Card — served as canonical JSON so bytes on wire match the JWS signature
let _cachedCardJson = null;
app.get("/.well-known/agent.json", async (_req, reply) => {
  if (!_cachedCardJson) {
    const cardUrl = PUBLIC_URL
      ? `${PUBLIC_URL.replace(/\/$/, "")}/.well-known/agent.json`
      : `http://${PUBLIC_ADDR ?? "localhost"}:${HTTP_PORT}/.well-known/agent.json`;
    _cachedCardJson = await buildSignedAgentCard(
      { name: "DAP Gateway", cardUrl, profiles: ["core/v0.2"], nodeClass: "CoreNode" },
      identity
    );
  }
  reply.header("Content-Type", "application/json; charset=utf-8");
  reply.header("Cache-Control", "public, max-age=300");
  reply.send(_cachedCardJson);
});

app.get("/agents", async () => ({
  agents: getPeersForExchange(100),
}));

app.get("/worlds", async () => {
  const worlds = findByCapability("world:");
  return {
    worlds: worlds.map((w) => {
      const cap = w.capabilities.find((c) => c.startsWith("world:")) ?? "";
      const worldId = cap.slice("world:".length);
      return {
        worldId,
        agentId: w.agentId,
        name: w.alias || worldId,
        reachable: w.endpoints?.length > 0,
        lastSeen: w.lastSeen,
      };
    }),
  };
});

app.get("/world/:worldId", async (req, reply) => {
  const { worldId } = req.params;
  const worlds = findByCapability(`world:${worldId}`);
  if (!worlds.length) return reply.code(404).send({ error: "World not found" });
  const w = worlds[0];
  return {
    worldId,
    agentId: w.agentId,
    name: w.alias || worldId,
    endpoints: w.endpoints,
    reachable: w.endpoints?.length > 0,
    subscribers: worldSubs.get(worldId)?.size ?? 0,
    lastSeen: w.lastSeen,
  };
});

// WebSocket endpoint: /ws?world=<worldId>
app.get("/ws", { websocket: true }, (socket, req) => {
  const worldId = new URL(req.url, "http://x").searchParams.get("world");
  if (!worldId) {
    socket.send(JSON.stringify({ type: "error", message: "Missing ?world= param" }));
    socket.close();
    return;
  }

  // Generate ephemeral browser session identity
  const seed = nacl.randomBytes(32);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const pubB64 = Buffer.from(kp.publicKey).toString("base64");
  const agentId = agentIdFromPublicKey(pubB64);
  const sessionId = agentId;

  sessions.set(sessionId, { agentId, keypair: kp, pubB64, worldId, alias: `guest-${agentId.slice(0, 6)}` });
  subscribe(worldId, socket);

  socket.send(JSON.stringify({ type: "connected", agentId, worldId }));
  console.log(`[gateway] WS connected: ${agentId.slice(0, 8)} → world:${worldId}`);

  socket.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    const session = sessions.get(sessionId);
    if (!session) return;

    switch (msg.type) {
      case "join": {
        if (msg.alias) session.alias = msg.alias.slice(0, 32);
        const result = await sendToWorld(worldId, "world.join", {
          alias: session.alias, agentId: session.agentId,
        });
        socket.send(JSON.stringify({ type: "join_result", ...result }));
        break;
      }
      case "action": {
        const result = await sendToWorld(worldId, "world.action", {
          action: msg.action, agentId: session.agentId,
          x: msg.x, y: msg.y, data: msg.data,
        });
        socket.send(JSON.stringify({ type: "action_result", ...result }));
        break;
      }
      case "leave": {
        await sendToWorld(worldId, "world.leave", { agentId: session.agentId });
        break;
      }
    }
  });

  socket.on("close", async () => {
    const session = sessions.get(sessionId);
    if (session) {
      await sendToWorld(worldId, "world.leave", { agentId: session.agentId });
      sessions.delete(sessionId);
    }
    unsubscribe(worldId, socket);
    console.log(`[gateway] WS disconnected: ${sessionId.slice(0, 8)}`);
  });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

await startPeerListener();
await app.listen({ port: HTTP_PORT, host: "::" });
console.log(`[gateway] Public HTTP on [::]:${HTTP_PORT}`);

// Discovery
setTimeout(discoverWorlds, 2_000);
setInterval(discoverWorlds, DISCOVERY_INTERVAL_MS);

// Prune stale peers every 5 minutes
setInterval(() => pruneStale(), 5 * 60 * 1000);
