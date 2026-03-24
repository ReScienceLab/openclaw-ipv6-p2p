/**
 * AWN Gateway — stateless portal + WebSocket bridge.
 * No OpenClaw dependency. Runs on plain HTTP/TCP.
 *
 * World Servers register with this Gateway via POST /agents (with a world: capability).
 * The Gateway maintains a peer DB and exposes discovered worlds via /worlds.
 *
 * HTTP Endpoints:
 *   GET  /health                       — health check
 *   GET  /ping                         — peer liveness
 *   GET  /worlds                       — list discovered world:* agents on AWN network
 *   GET  /worlds/:worldId              — info about a specific world
 *   DELETE /worlds/:worldId            — deregister a world (admin, requires GATEWAY_ADMIN_KEY bearer token if set)
 *   GET  /agents                       — list all known AWN agents
 *   GET  /agents/:agentId              — get a specific agent record
 *   DELETE /agents/:agentId            — deregister an agent (admin, requires GATEWAY_ADMIN_KEY bearer token if set)
 *   POST /agents                       — register or re-announce an agent (online)
 *   POST /agents/:agentId/heartbeat    — agent liveness heartbeat
 *   POST /worlds/:worldId/heartbeat    — world server liveness heartbeat
 *   POST /messages                     — inbound signed message (world.state broadcasts)
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
 *   HTTP_PORT         — gateway public HTTP port (default 8100)
 *   PEER_PORT         — outbound port for world agent connections (default 8099)
 *   PUBLIC_ADDR       — own public IP/hostname for AWN announce
 *   DATA_DIR          — identity persistence (default /data)
 *   STALE_TTL_MS      — agent stale TTL in ms (default 90000)
 *   WEBHOOK_URL       — optional URL for world.announced webhook notifications
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import Fastify from "fastify"
import websocketPlugin from "@fastify/websocket"
import cors from "@fastify/cors"
import swagger from "@fastify/swagger"
import swaggerUi from "@fastify/swagger-ui"
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

const DEFAULT_PEER_PORT = parseInt(process.env.PEER_PORT ?? "8099")
const DEFAULT_HTTP_PORT = parseInt(process.env.HTTP_PORT ?? "8100")
const DEFAULT_PUBLIC_ADDR = process.env.PUBLIC_ADDR ?? null
const DEFAULT_PUBLIC_URL = process.env.PUBLIC_URL ?? null
const DEFAULT_DATA_DIR = process.env.DATA_DIR ?? "/data"
const DEFAULT_STALE_TTL_MS = parseInt(process.env.STALE_TTL_MS ?? String(90 * 1000))
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? null
const MAX_AGENTS = 500
const REGISTRY_VERSION = 1
const SAVE_DEBOUNCE_MS = 1000

// ---------------------------------------------------------------------------
// Factory — all state is scoped to each createGatewayApp() invocation
// ---------------------------------------------------------------------------

export async function createGatewayApp(opts = {}) {
  const {
    dataDir = DEFAULT_DATA_DIR,
    httpPort = DEFAULT_HTTP_PORT,
    peerPort = DEFAULT_PEER_PORT,
    publicAddr = DEFAULT_PUBLIC_ADDR,
    publicUrl = DEFAULT_PUBLIC_URL,
    staleTtlMs = DEFAULT_STALE_TTL_MS,
    webhookUrl = WEBHOOK_URL,
  } = opts

  const REGISTRY_PATH = path.join(dataDir, "registry.json")
  const REGISTRY_TMP_PATH = `${REGISTRY_PATH}.tmp`

  // ---------------------------------------------------------------------------
  // Identity
  // ---------------------------------------------------------------------------

  const identity = loadOrCreateIdentity(dataDir, "gateway-identity")
  const selfPubB64 = identity.pubB64
  const selfAgentId = identity.agentId

  // ---------------------------------------------------------------------------
  // Registry
  // ---------------------------------------------------------------------------

  const registry = new Map() // agentId -> AgentRecord
  let _saveTimer = null
  let _tickTimer = null
  let _shutdownPromise = null
  let _registryModifiedAt = null

  function writeRegistry() {
    fs.mkdirSync(dataDir, { recursive: true })
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
      _registryModifiedAt = null
      return
    }

    try {
      const raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"))
      if (raw?.version !== REGISTRY_VERSION || !raw?.agents || typeof raw.agents !== "object") {
        throw new Error("invalid registry schema")
      }

      registry.clear()
      const cutoff = Date.now() - staleTtlMs
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

      _registryModifiedAt = loaded > 0
        ? (typeof raw.savedAt === "number" ? raw.savedAt : Date.now())
        : null
      console.log(`[gateway] Loaded ${loaded} agents from registry (discarded ${discarded} stale)`)
    } catch (error) {
      console.warn(`[gateway] Failed to load registry from ${REGISTRY_PATH}; starting with empty registry`, error)
      registry.clear()
      _registryModifiedAt = null
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
    const firstSeen = existing === undefined
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
    if (changed || trimmed) {
      _registryModifiedAt = now
    }
    if (persist && (changed || trimmed)) {
      saveRegistry()
    }
    if (firstSeen && webhookUrl) {
      const caps = nextRecord.capabilities ?? []
      const worldCap = caps.find((c) => c.startsWith("world:"))
      const worldId = worldCap ? worldCap.slice("world:".length) : undefined
      fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "world.announced", agentId, worldId, ts: Date.now() }),
        signal: AbortSignal.timeout(5_000),
      }).catch(() => {})
    }
  }

  function pruneStaleAgents(ttl = staleTtlMs) {
    const cutoff = Date.now() - ttl
    let pruned = 0
    for (const [id, p] of registry) {
      if (p.lastSeen < cutoff) { registry.delete(id); pruned++ }
    }
    if (pruned > 0) {
      console.log(`[gateway] Pruned ${pruned} stale agent(s) (TTL ${ttl / 1000}s)`)
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
  // WebSocket subscriptions
  // ---------------------------------------------------------------------------

  const worldSubs = new Map()
  const sessions = new Map()

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
        const port = ep.port ?? peerPort;
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
  // Public HTTP + WebSocket server
  // ---------------------------------------------------------------------------

  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  await app.register(websocketPlugin);

  const { allSchemas } = await import("./schemas.mjs");
  await app.register(swagger, {
    openapi: {
      info: {
        title: "AWN Gateway",
        description:
          "Agent World Network Gateway — stateless portal + WebSocket bridge.\n" +
          "World Servers register via POST /agents (with a `world:` capability) and stay alive\n" +
          "with periodic POST /agents/:agentId/heartbeat signals.\n\n" +
          "**WebSocket** — `ws://{host}/ws?world={worldId}` subscribes to a world's\n" +
          "real-time events (world.state broadcasts, join/leave/action messages).",
        version: "0.5.0",
        license: { name: "MIT" },
      },
      servers: [{ url: "http://localhost:8100", description: "Local development" }],
    },
    refResolver: {
      buildLocalReference(json) {
        return json.$id || json.title || `def-${json.$id}`
      },
    },
  });
  for (const s of allSchemas) app.addSchema(s);
  await app.register(swaggerUi, { routePrefix: "/docs" });

  app.get("/health", {
    schema: {
      summary: "Health check",
      operationId: "getHealth",
      tags: ["gateway"],
      response: {
        200: {
          type: "object",
          required: ["ok", "ts", "agentId", "agents", "worlds", "status"],
          properties: {
            ok: { type: "boolean" },
            ts: { type: "integer", description: "Unix timestamp (ms)" },
            agentId: { type: "string" },
            agents: { type: "integer", description: "Number of known agents" },
            worlds: { type: "integer", description: "Number of discovered worlds" },
            registryAge: { type: ["integer", "null"], description: "Milliseconds since last registry modification" },
            status: { type: "string", enum: ["ready", "warming", "empty"] },
          },
        },
      },
    },
  }, async () => {
    const ts = Date.now()
    const worlds = findByCapability("world:").length
    const agents = registry.size
    const registryAge = agents > 0 && _registryModifiedAt !== null
      ? Math.max(0, ts - _registryModifiedAt)
      : null
    const status = worlds > 0 ? "ready" : agents > 0 ? "warming" : "empty"

    return {
      ok: true,
      ts,
      agentId: selfAgentId,
      agents,
      worlds,
      registryAge,
      status,
    }
  });

  app.get("/ping", {
    schema: {
      summary: "Peer liveness check",
      operationId: "getPing",
      tags: ["gateway"],
      response: {
        200: {
          type: "object",
          required: ["ok", "ts", "role"],
          properties: {
            ok: { type: "boolean" },
            ts: { type: "integer" },
            role: { type: "string", enum: ["gateway"] },
          },
        },
      },
    },
  }, async () => ({ ok: true, ts: Date.now(), role: "gateway" }));

  let _cachedCardJson = null
  app.get("/.well-known/agent.json", {
    schema: {
      summary: "AgentWorld agent card",
      operationId: "getAgentCard",
      tags: ["gateway"],
      description: "Returns a JWS-signed Agent Card for the gateway.",
      response: { 200: { type: "object" } },
    },
  }, async (_req, reply) => {
    if (!_cachedCardJson) {
      const cardUrl = publicUrl
        ? `${publicUrl.replace(/\/$/, "")}/.well-known/agent.json`
        : `http://${publicAddr ?? "localhost"}:${httpPort}/.well-known/agent.json`;
      _cachedCardJson = await buildSignedAgentCard(
        { name: "AWN Gateway", cardUrl, profiles: ["core/v0.2"], nodeClass: "CoreNode" },
        identity
      );
    }
    reply.header("Content-Type", "application/json; charset=utf-8");
    reply.header("Cache-Control", "public, max-age=300");
    reply.send(_cachedCardJson);
  });

  app.get("/agents", {
    schema: {
      summary: "List all known AWN agents",
      operationId: "getAgents",
      tags: ["gateway"],
      response: {
        200: {
          type: "object",
          required: ["agents"],
          properties: { agents: { type: "array", items: { $ref: "AgentRecord#" } } },
        },
      },
    },
  }, async () => ({
    agents: getAgentsForExchange(100),
  }));

  app.get("/worlds", {
    schema: {
      summary: "List discovered worlds",
      operationId: "getWorlds",
      tags: ["gateway"],
      response: {
        200: {
          type: "object",
          required: ["worlds"],
          properties: { worlds: { type: "array", items: { $ref: "WorldSummary#" } } },
        },
      },
    },
  }, async () => {
    const worlds = findByCapability("world:");
    return {
      worlds: worlds.map((w) => {
        const cap = w.capabilities.find((c) => c.startsWith("world:")) ?? "";
        const worldId = cap.slice("world:".length);
        return {
          worldId,
          agentId: w.agentId,
          name: w.alias || worldId,
          endpoints: w.endpoints ?? [],
          reachable: w.endpoints?.length > 0,
          lastSeen: w.lastSeen,
        };
      }),
    };
  });

  app.get("/worlds/:worldId", {
    schema: {
      summary: "Get info about a specific world",
      operationId: "getWorld",
      tags: ["gateway"],
      params: {
        type: "object",
        required: ["worldId"],
        properties: { worldId: { type: "string" } },
      },
      response: {
        200: { $ref: "WorldDetail#" },
        404: { $ref: "Error#" },
      },
    },
  }, async (req, reply) => {
    const { worldId } = req.params;
    const worlds = findByCapability(`world:${worldId}`);
    if (!worlds.length) return reply.code(404).send({ error: "World not found" });
    const w = worlds[0];
    return {
      worldId,
      agentId: w.agentId,
      publicKey: w.publicKey,
      name: w.alias || worldId,
      endpoints: w.endpoints,
      reachable: w.endpoints?.length > 0,
      subscribers: worldSubs.get(worldId)?.size ?? 0,
      lastSeen: w.lastSeen,
    };
  });

  app.delete("/worlds/:worldId", {
    schema: {
      summary: "Deregister a world (admin)",
      operationId: "deleteWorld",
      tags: ["gateway"],
      params: {
        type: "object",
        required: ["worldId"],
        properties: { worldId: { type: "string" } },
      },
      response: {
        200: {
          type: "object",
          required: ["ok", "removed"],
          properties: { ok: { type: "boolean" }, removed: { type: "integer" } },
        },
        403: { $ref: "Error#" },
        404: { $ref: "Error#" },
      },
    },
  }, async (req, reply) => {
    const adminKey = process.env.GATEWAY_ADMIN_KEY;
    if (adminKey) {
      const auth = req.headers["authorization"] ?? "";
      if (auth !== `Bearer ${adminKey}`) {
        return reply.code(403).send({ error: "Forbidden" });
      }
    }
    const { worldId } = req.params;
    const worlds = findByCapability(`world:${worldId}`);
    if (!worlds.length) return reply.code(404).send({ error: "World not found" });
    let removed = 0;
    for (const w of worlds) {
      registry.delete(w.agentId);
      removed++;
    }
    _registryModifiedAt = Date.now();
    flushRegistry();
    console.log(`[gateway] Deregistered world:${worldId} (${removed} agent(s) removed)`);
    return { ok: true, removed };
  });

  app.get("/agents/:agentId", {
    schema: {
      summary: "Get a specific agent record",
      operationId: "getAgent",
      tags: ["gateway"],
      params: {
        type: "object",
        required: ["agentId"],
        properties: { agentId: { type: "string" } },
      },
      response: {
        200: { $ref: "AgentRecord#" },
        404: { $ref: "Error#" },
      },
    },
  }, async (req, reply) => {
    const { agentId } = req.params;
    const agent = registry.get(agentId);
    if (!agent) return reply.code(404).send({ error: "Agent not found" });
    return agent;
  });

  app.delete("/agents/:agentId", {
    schema: {
      summary: "Deregister an agent (admin)",
      operationId: "deleteAgent",
      tags: ["gateway"],
      params: {
        type: "object",
        required: ["agentId"],
        properties: { agentId: { type: "string" } },
      },
      response: {
        200: {
          type: "object",
          required: ["ok"],
          properties: { ok: { type: "boolean" } },
        },
        403: { $ref: "Error#" },
        404: { $ref: "Error#" },
      },
    },
  }, async (req, reply) => {
    const adminKey = process.env.GATEWAY_ADMIN_KEY;
    if (adminKey) {
      const auth = req.headers["authorization"] ?? "";
      if (auth !== `Bearer ${adminKey}`) {
        return reply.code(403).send({ error: "Forbidden" });
      }
    }
    const { agentId } = req.params;
    if (!registry.has(agentId)) return reply.code(404).send({ error: "Agent not found" });
    registry.delete(agentId);
    _registryModifiedAt = Date.now();
    flushRegistry();
    console.log(`[gateway] Deregistered agent:${agentId}`);
    return { ok: true };
  });

  app.get("/ws", { websocket: true }, (socket, req) => {
    const worldId = new URL(req.url, "http://x").searchParams.get("world");
    if (!worldId) {
      socket.send(JSON.stringify({ type: "error", message: "Missing ?world= param" }));
      socket.close();
      return;
    }

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
  // Peer routes
  // ---------------------------------------------------------------------------

  await app.register(async (peer) => {
    peer.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
      try {
        req.rawBody = body;
        done(null, JSON.parse(body));
      } catch (err) {
        done(err, undefined);
      }
    });

    // Skip body validation for peer routes — signature verification is the
    // validation layer, and Fastify's schema validation would interfere with
    // the custom content parser that preserves rawBody for signature checks.
    const noValidate = () => () => true;
    peer.setValidatorCompiler(noValidate);

    peer.post("/agents", {
      schema: {
        summary: "Register or re-announce an agent (online)",
        operationId: "postAgents",
        tags: ["gateway"],
        description: "Ed25519-signed agent registration. World servers include a `world:` capability.",
        body: { $ref: "AnnounceRequest#" },
        response: {
          200: {
            type: "object",
            required: ["ok", "agents"],
            properties: {
              ok: { type: "boolean" },
              agents: { type: "array", items: { $ref: "AgentRecord#" } },
            },
          },
          400: { $ref: "Error#" },
          403: { $ref: "Error#" },
        },
      },
    }, async (req, reply) => {
      const ann = req.body;
      if (!ann?.publicKey || !ann?.from) return reply.code(400).send({ error: "Invalid announce" });

      const awSig = req.headers["x-agentworld-signature"];
      if (awSig) {
        const authority = req.headers["host"] ?? "localhost";
        const result = verifyHttpRequestHeaders(req.headers, req.method, req.url, authority, req.rawBody, ann.publicKey);
        if (!result.ok) return reply.code(403).send({ error: result.error });
      } else {
        const { signature, ...signable } = ann;
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
      return { ok: true, agents: getAgentsForExchange(20) };
    });

    peer.post("/agents/:agentId/heartbeat", {
      schema: {
        summary: "Lightweight liveness heartbeat",
        operationId: "postHeartbeat",
        tags: ["gateway"],
        description: "Updates an agent's lastSeen without a full re-announce.",
        params: {
          type: "object",
          required: ["agentId"],
          properties: { agentId: { type: "string" } },
        },
        body: { $ref: "HeartbeatRequest#" },
        response: {
          200: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
          400: { $ref: "Error#" },
          403: { $ref: "Error#" },
          404: { $ref: "Error#" },
        },
      },
    }, async (req, reply) => {
      const { agentId } = req.params;
      const { ts, signature } = req.body ?? {};
      if (!ts || !signature) return reply.code(400).send({ error: "Invalid heartbeat" });

      const skew = Math.abs(Date.now() - ts);
      if (skew > 5 * 60 * 1000) return reply.code(400).send({ error: "Timestamp out of range" });

      const existing = registry.get(agentId);
      if (!existing) return reply.code(404).send({ error: "Unknown agent" });

      const ok = verifyWithDomainSeparator(
        DOMAIN_SEPARATORS.HEARTBEAT,
        existing.publicKey,
        { agentId, ts },
        signature
      );
      if (!ok) return reply.code(403).send({ error: "Invalid signature" });

      existing.lastSeen = Date.now();
      _registryModifiedAt = existing.lastSeen;
      return { ok: true };
    });

    peer.post("/worlds/:worldId/heartbeat", {
      schema: {
        summary: "World server liveness heartbeat",
        operationId: "postWorldHeartbeat",
        tags: ["gateway"],
        description: "Updates a world server's lastSeen without a full re-announce.",
        params: {
          type: "object",
          required: ["worldId"],
          properties: { worldId: { type: "string" } },
        },
        body: { $ref: "HeartbeatRequest#" },
        response: {
          200: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
          400: { $ref: "Error#" },
          403: { $ref: "Error#" },
          404: { $ref: "Error#" },
        },
      },
    }, async (req, reply) => {
      const { worldId } = req.params;
      const { ts, signature } = req.body ?? {};
      if (!ts || !signature) return reply.code(400).send({ error: "Invalid heartbeat" });

      const skew = Math.abs(Date.now() - ts);
      if (skew > 5 * 60 * 1000) return reply.code(400).send({ error: "Timestamp out of range" });

      const worlds = findByCapability(`world:${worldId}`);
      if (!worlds.length) return reply.code(404).send({ error: "World not found" });
      const existing = worlds[0];

      const ok = verifyWithDomainSeparator(
        DOMAIN_SEPARATORS.HEARTBEAT,
        existing.publicKey,
        { worldId, ts },
        signature
      );
      if (!ok) return reply.code(403).send({ error: "Invalid signature" });

      existing.lastSeen = Date.now();
      _registryModifiedAt = existing.lastSeen;
      return { ok: true };
    });

    peer.post("/messages", {
      schema: {
        summary: "Inbound signed message (world.state broadcasts)",
        operationId: "postMessages",
        tags: ["gateway"],
        description: "Receives Ed25519-signed messages from world servers.",
        body: { $ref: "SignedMessage#" },
        response: {
          200: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
          400: { $ref: "Error#" },
          403: { $ref: "Error#" },
        },
      },
    }, async (req, reply) => {
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

      if (msg.event === "world.state") {
        let state;
        try { state = typeof msg.content === "string" ? JSON.parse(msg.content) : msg.content; } catch { return { ok: true }; }
        const worldId = state.worldId;
        if (worldId) broadcast(worldId, { type: "world.state", ...state });
      }

      return { ok: true };
    });
  });

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async function stop() {
    if (_shutdownPromise) return _shutdownPromise

    _shutdownPromise = (async () => {
      if (_tickTimer) {
        clearInterval(_tickTimer)
        _tickTimer = null
      }
      flushRegistry()
      try {
        await app.close()
      } catch (error) {
        console.warn("[gateway] Failed to close server cleanly", error)
      }
    })()

    return _shutdownPromise
  }

  async function start() {
    loadRegistry()
    await app.listen({ port: httpPort, host: "::" })
    console.log(`[gateway] agentId=${selfAgentId}`)
    console.log(`[gateway] HTTP on [::]:${httpPort}`)
    _tickTimer = setInterval(() => {
      pruneStaleAgents()
      if (_registryModifiedAt !== null) {
        try { writeRegistry() } catch (error) {
          console.warn("[gateway] Periodic snapshot failed", error)
        }
      }
    }, 30_000)
    for (const signal of ["SIGTERM", "SIGINT"]) {
      process.once(signal, () => void stop())
    }
  }

  return { app, start, stop }
}

// ---------------------------------------------------------------------------
// Auto-start when run directly
// ---------------------------------------------------------------------------

const _isMain = process.argv[1] === fileURLToPath(new URL(import.meta.url))
if (_isMain) {
  const { start } = await createGatewayApp()
  await start()
}
