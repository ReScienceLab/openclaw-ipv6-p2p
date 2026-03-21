/**
 * AWN Gateway — stateless portal + WebSocket bridge.
 * No OpenClaw dependency. Runs on plain HTTP/TCP.
 *
 * World Servers announce directly to this Gateway via POST /peer/announce.
 * The Gateway maintains a peer DB and exposes discovered worlds via /worlds.
 *
 * HTTP Endpoints:
 *   GET  /health          — health check
 *   GET  /worlds          — list discovered world:* agents on AWN network
 *   GET  /agents          — list all known AWN agents
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
 *   PEER_PORT         — AWN peer HTTP port (default 8099)
 *   HTTP_PORT         — gateway public HTTP port (default 8100)
 *   PUBLIC_ADDR       — own public IP/hostname for AWN announce
 *   DATA_DIR          — identity persistence (default /data)
 */
import fs from "node:fs"
import path from "node:path"
import Fastify from "fastify"
import websocketPlugin from "@fastify/websocket"
import cors from "@fastify/cors"
import nacl from "tweetnacl"
import {
  agentIdFromPublicKey,
  canonicalize,
  verifySignature,
  signPayload,
  signHttpRequest,
  verifyHttpRequestHeaders,
  loadOrCreateIdentity,
  buildSignedAgentCard,
  verifyWithDomainSeparator,
  DOMAIN_SEPARATORS,
} from "@resciencelab/agent-world-sdk"

const PEER_PORT = parseInt(process.env.PEER_PORT ?? "8099")
const HTTP_PORT = parseInt(process.env.HTTP_PORT ?? "8100")
const PUBLIC_ADDR = process.env.PUBLIC_ADDR ?? null
const PUBLIC_URL = process.env.PUBLIC_URL ?? null // e.g. https://gateway.example.com
const DATA_DIR = process.env.DATA_DIR ?? "/data"
const STALE_TTL_MS = parseInt(process.env.STALE_TTL_MS ?? String(15 * 60 * 1000)) // 15 min
const MAX_AGENTS = 500
const REGISTRY_VERSION = 1
const REGISTRY_PATH = path.join(DATA_DIR, "registry.json")
const REGISTRY_TMP_PATH = `${REGISTRY_PATH}.tmp`
const SAVE_DEBOUNCE_MS = 1000

// ---------------------------------------------------------------------------
// Identity (loaded via agent-world-sdk)
// ---------------------------------------------------------------------------

const identity = loadOrCreateIdentity(DATA_DIR, "gateway-identity")
const selfPubB64 = identity.pubB64
const selfAgentId = identity.agentId

console.log(`[gateway] agentId=${selfAgentId}`)

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
const registry = new Map() // agentId -> PeerRecord
let _saveTimer = null

function writeRegistry() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const payload = {
    version: REGISTRY_VERSION,
    savedAt: Date.now(),
    agents: Object.fromEntries([...registry.entries()]),
  }
  fs.writeFileSync(REGISTRY_TMP_PATH, JSON.stringify(payload, null, 2))
  fs.renameSync(REGISTRY_TMP_PATH, REGISTRY_PATH)
}

function loadRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    console.warn(`[gateway] Registry file missing at ${REGISTRY_PATH}; starting with empty registry`)
    registry.clear()
    return
  }

  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"))
    if (raw?.version !== REGISTRY_VERSION || !raw?.agents || typeof raw.agents !== "object") {
      throw new Error("invalid registry schema")
    }

    registry.clear()
    const cutoff = Date.now() - STALE_TTL_MS
    let loaded = 0
    let discarded = 0

    for (const [agentId, record] of Object.entries(raw.agents)) {
      if (!record || typeof record !== "object") {
        discarded++
        continue
      }
      const lastSeen = typeof record.lastSeen === "number" ? record.lastSeen : 0
      if (lastSeen < cutoff) {
        discarded++
        continue
      }
      registry.set(agentId, record)
      loaded++
    }

    console.log(`[gateway] Loaded ${loaded} agents from registry (discarded ${discarded} stale)`)
  } catch (error) {
    console.warn(`[gateway] Failed to load registry from ${REGISTRY_PATH}; starting with empty registry`, error)
    registry.clear()
  }
}

function saveRegistry() {
  if (_saveTimer) return
  _saveTimer = setTimeout(() => {
    _saveTimer = null
    try {
      writeRegistry()
    } catch (error) {
      console.warn(`[gateway] Failed to save registry to ${REGISTRY_PATH}`, error)
    }
  }, SAVE_DEBOUNCE_MS)
}

function flushRegistry() {
  if (_saveTimer) {
    clearTimeout(_saveTimer)
    _saveTimer = null
  }

  try {
    writeRegistry()
  } catch (error) {
    console.warn(`[gateway] Failed to flush registry to ${REGISTRY_PATH}`, error)
  }
}

function upsertAgent(agentId, publicKey, opts = {}) {
  const persist = opts.persist === true
  const now = Date.now()
  const existing = registry.get(agentId)
  // For gossipped agents, preserve the original lastSeen from the sender
  // Only use Date.now() for direct contacts (no lastSeen provided)
  const lastSeen = opts.lastSeen
    ? Math.max(existing?.lastSeen ?? 0, opts.lastSeen)
    : now
  const nextRecord = {
    agentId,
    publicKey: publicKey || existing?.publicKey || "",
    alias: opts.alias ?? existing?.alias ?? "",
    endpoints: opts.endpoints ?? existing?.endpoints ?? [],
    capabilities: opts.capabilities ?? existing?.capabilities ?? [],
    lastSeen,
  }
  const changed = JSON.stringify(existing ?? null) !== JSON.stringify(nextRecord)
  registry.set(agentId, nextRecord)
  let trimmed = false
  if (registry.size > MAX_AGENTS) {
    const oldest = [...registry.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0]
    registry.delete(oldest.agentId)
    trimmed = true
  }
  if (persist && (changed || trimmed)) {
    saveRegistry()
  }
}

function pruneStaleAgents(ttl = STALE_TTL_MS) {
  const cutoff = Date.now() - ttl
  let pruned = 0
  for (const [id, p] of registry) {
    if (p.lastSeen < cutoff) { registry.delete(id); pruned++ }
  }
  if (pruned > 0) {
    console.log(`[gateway] Pruned ${pruned} stale agent(s) (TTL ${Math.round(ttl / 60000)}min)`)
    flushRegistry()
  }
}

function getAgentsForExchange(limit = 50) {
  return [...registry.values()]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, limit)
    .map(({ agentId, publicKey, alias, endpoints, capabilities, lastSeen }) => ({
      agentId, publicKey, alias, endpoints: endpoints ?? [], capabilities: capabilities ?? [], lastSeen,
    }))
}

function findByCapability(cap) {
  const isPrefix = cap.endsWith(":");
  return [...registry.values()].filter((p) =>
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
// Outbound AWN messaging (gateway → world agent)
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
// AWN peer server (receive world.state broadcasts from World Agents)
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
  peerServer.get("/peer/peers", async () => ({ peers: getAgentsForExchange() }));

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
      // Try domain-separated verification first, then fall back to plain for backward compat
      const domainOk = verifyWithDomainSeparator(DOMAIN_SEPARATORS.ANNOUNCE, ann.publicKey, signable, signature);
      if (!domainOk && !verifySignature(ann.publicKey, signable, signature)) {
        return reply.code(403).send({ error: "Invalid signature" });
      }
    }

    if (agentIdFromPublicKey(ann.publicKey) !== ann.from) {
      return reply.code(400).send({ error: "agentId mismatch" });
    }
    upsertAgent(ann.from, ann.publicKey, {
      alias: ann.alias, endpoints: ann.endpoints, capabilities: ann.capabilities, persist: true,
    });
    return { ok: true, peers: getAgentsForExchange(20) };
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

    return { ok: true };
  });

  await peerServer.listen({ port: PEER_PORT, host: "::" });
  console.log(`[gateway] AWN peer listener on [::]:${PEER_PORT}`);
}

// ---------------------------------------------------------------------------
// Public HTTP + WebSocket server
// ---------------------------------------------------------------------------

const app = Fastify({ logger: false });
await app.register(cors, { origin: true });
await app.register(websocketPlugin);

app.get("/health", async () => ({
  ok: true, ts: Date.now(), agentId: selfAgentId,
  agents: registry.size, worlds: findByCapability("world:").length,
}));

// Agent Card — served as canonical JSON so bytes on wire match the JWS signature
let _cachedCardJson = null
app.get("/.well-known/agent.json", async (_req, reply) => {
  if (!_cachedCardJson) {
    const cardUrl = PUBLIC_URL
      ? `${PUBLIC_URL.replace(/\/$/, "")}/.well-known/agent.json`
      : `http://${PUBLIC_ADDR ?? "localhost"}:${HTTP_PORT}/.well-known/agent.json`;
    _cachedCardJson = await buildSignedAgentCard(
      { name: "AWN Gateway", cardUrl, profiles: ["core/v0.2"], nodeClass: "CoreNode" },
      identity
    );
  }
  reply.header("Content-Type", "application/json; charset=utf-8");
  reply.header("Cache-Control", "public, max-age=300");
  reply.send(_cachedCardJson);
});

app.get("/agents", async () => ({
  agents: getAgentsForExchange(100),
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

loadRegistry()
await startPeerListener()
await app.listen({ port: HTTP_PORT, host: "::" })
console.log(`[gateway] Public HTTP on [::]:${HTTP_PORT}`)

// Prune stale agents every 3 minutes
setInterval(() => pruneStaleAgents(), 3 * 60 * 1000)
