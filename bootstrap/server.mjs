/**
 * DAP Bootstrap Node — standalone peer exchange server.
 * No OpenClaw dependency. Runs on plain HTTP/TCP.
 *
 * Endpoints:
 *   GET  /peer/ping     — health check
 *   GET  /peer/peers    — return known peer list
 *   POST /peer/announce — accept signed peer announcement, return our peer list
 *   POST /peer/message  — receive a signed P2P message; reply via Kimi AI (rate-limited)
 */
import Fastify from "fastify";
import nacl from "tweetnacl";
import fs from "fs";
import path from "path";
import dgram from "node:dgram";
import crypto from "node:crypto";

const PORT = parseInt(process.env.PEER_PORT ?? "8099");
const DATA_DIR = process.env.DATA_DIR ?? "/data";
const TEST_MODE = process.env.TEST_MODE === "true";
const MAX_PEERS = 500;
const AGENT_VERSION = process.env.AGENT_VERSION ?? "1.0.0";
const PERSIST_INTERVAL_MS = 30_000;

const KIMI_REGION = process.env.AWS_REGION ?? "us-east-2";
const KIMI_SSM_PARAM = process.env.KIMI_SSM_PARAM ?? "/dap/kimi-api-key";
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX ?? "10");
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? String(60 * 60 * 1000));

let kimiApiKey = process.env.KIMI_API_KEY ?? null;
const rateLimits = new Map(); // agentId -> { count, windowStart }
const tofuCache = new Map();  // agentId -> publicKey b64

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

/** Derive agentId from a base64 Ed25519 public key — AgentWorld v0.2 aw:sha256: format */
function agentIdFromPublicKey(publicKeyB64) {
  const pubBytes = Buffer.from(publicKeyB64, "base64");
  return `aw:sha256:${crypto.createHash("sha256").update(pubBytes).digest("hex")}`;
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
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Peer DB (in-memory + JSON persistence)
// ---------------------------------------------------------------------------
const peers = new Map(); // agentId -> PeerRecord

function loadPeers() {
  const file = path.join(DATA_DIR, "peers.json");
  if (!fs.existsSync(file)) return;
  try {
    const records = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const r of records) {
      // Always recompute agentId from publicKey to migrate legacy 32-char IDs
      const id = r.publicKey ? agentIdFromPublicKey(r.publicKey) : r.agentId;
      if (!id) continue;
      peers.set(id, { ...r, agentId: id });
    }
    console.log(`[bootstrap] Loaded ${peers.size} peers from disk`);
  } catch (e) {
    console.warn("[bootstrap] Could not load peers.json:", e.message);
  }
}

function savePeers() {
  const file = path.join(DATA_DIR, "peers.json");
  try {
    fs.writeFileSync(file, JSON.stringify([...peers.values()], null, 2));
  } catch (e) {
    console.warn("[bootstrap] Could not save peers.json:", e.message);
  }
}

/**
 * Upsert a peer record.
 * opts.lastSeen: if provided (gossip path), preserve provenance — only advance if newer.
 */
function upsertPeer(agentId, publicKey, opts = {}) {
  const now = Date.now();
  const existing = peers.get(agentId);
  let lastSeen;
  if (opts.lastSeen !== undefined) {
    lastSeen = Math.max(existing?.lastSeen ?? 0, opts.lastSeen);
  } else {
    lastSeen = now;
  }
  peers.set(agentId, {
    agentId,
    publicKey,
    alias: opts.alias ?? existing?.alias ?? "",
    version: opts.version ?? existing?.version,
    endpoints: opts.endpoints ?? existing?.endpoints ?? [],
    firstSeen: existing?.firstSeen ?? now,
    lastSeen,
    source: opts.source ?? "gossip",
    discoveredVia: opts.discoveredVia ?? existing?.discoveredVia,
  });
  if (peers.size > MAX_PEERS) {
    const sorted = [...peers.values()].sort((a, b) => a.lastSeen - b.lastSeen);
    peers.delete(sorted[0].agentId);
  }
}

function pruneStale(maxAgeMs, protectedIds = []) {
  const cutoff = Date.now() - maxAgeMs;
  let pruned = 0;
  for (const [id, record] of peers) {
    if (protectedIds.includes(id)) continue;
    if (record.lastSeen < cutoff) {
      peers.delete(id);
      pruned++;
    }
  }
  if (pruned > 0) console.log(`[bootstrap] Pruned ${pruned} stale peer(s)`);
  return pruned;
}

function getPeersForExchange(limit = 50) {
  return [...peers.values()]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, limit)
    .map(({ agentId, publicKey, alias, version, endpoints, lastSeen }) => ({
      agentId,
      publicKey,
      alias,
      version,
      endpoints: endpoints ?? [],
      lastSeen,
    }));
}

// ---------------------------------------------------------------------------
// Bootstrap identity
// ---------------------------------------------------------------------------
fs.mkdirSync(DATA_DIR, { recursive: true });

const idFile = path.join(DATA_DIR, "bootstrap-identity.json");
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
let _agentName = process.env.AGENT_NAME ?? `DAP Bootstrap Node (${selfAgentId.slice(0, 8)})`;

// ---------------------------------------------------------------------------
// Peer DB + pruning
// ---------------------------------------------------------------------------
loadPeers();
setInterval(savePeers, PERSIST_INTERVAL_MS);
const STALE_TTL_MS = parseInt(process.env.STALE_TTL_MS ?? String(48 * 60 * 60 * 1000));
setInterval(() => pruneStale(STALE_TTL_MS), 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// Kimi bot helpers
// ---------------------------------------------------------------------------

async function loadKimiKey() {
  if (kimiApiKey) return;
  try {
    const { execSync } = await import("child_process");
    const out = execSync(
      `aws ssm get-parameter --name "${KIMI_SSM_PARAM}" --with-decryption --region ${KIMI_REGION} --query Parameter.Value --output text`,
      { encoding: "utf8", timeout: 10_000 }
    );
    kimiApiKey = out.trim();
    console.log("[bootstrap] Kimi API key loaded from SSM");
  } catch (e) {
    console.warn("[bootstrap] Could not load Kimi key from SSM:", e.message);
  }
}

function checkRateLimit(agentId) {
  const now = Date.now();
  const rec = rateLimits.get(agentId) ?? { count: 0, windowStart: now };
  if (now - rec.windowStart > RATE_LIMIT_WINDOW_MS) {
    rec.count = 0;
    rec.windowStart = now;
  }
  if (rec.count >= RATE_LIMIT_MAX) return false;
  rec.count++;
  rateLimits.set(agentId, rec);
  return true;
}

const PEER_DEFAULT_PORT = 8099;

async function sendMessageToEndpoints(endpoints, content) {
  if (!endpoints?.length) return;
  const sorted = [...endpoints].sort((a, b) => a.priority - b.priority);
  for (const ep of sorted) {
    try {
      const addr = ep.address;
      const port = ep.port ?? PEER_DEFAULT_PORT;
      const isIpv6 = addr.includes(":") && !addr.includes(".");
      const url = isIpv6
        ? `http://[${addr}]:${port}/peer/message`
        : `http://${addr}:${port}/peer/message`;

      const payload = {
        from: selfAgentId,
        publicKey: selfPubB64,
        event: "chat",
        content,
        timestamp: Date.now(),
      };
      const sig = nacl.sign.detached(
        Buffer.from(JSON.stringify(canonicalize(payload))),
        selfKeypair.secretKey
      );
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, signature: Buffer.from(sig).toString("base64") }),
        signal: AbortSignal.timeout(10_000),
      });
      return; // sent successfully via first reachable endpoint
    } catch {}
  }
}

async function callKimi(userMessage) {
  if (!kimiApiKey) return null;
  try {
    const resp = await fetch("https://api.moonshot.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${kimiApiKey}`,
      },
      body: JSON.stringify({
        model: "moonshot-v1-8k",
        messages: [
          {
            role: "system",
            content: `You are a friendly AI assistant deployed on the DAP P2P network — an open-source project enabling direct encrypted messaging between AI agents. Your name is "${_agentName}". You are an always-on node to help new users get started. Keep replies concise (under 150 words). If asked how to find more peers, tell users to run: openclaw p2p discover`,
          },
          { role: "user", content: userMessage },
        ],
        max_tokens: 300,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.choices?.[0]?.message?.content ?? null;
  } catch (e) {
    console.warn("[bootstrap] Kimi API error:", e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = Fastify({ logger: false });

server.get("/peer/ping", async () => ({
  ok: true,
  ts: Date.now(),
  bootstrap: true,
  peers: peers.size,
}));

server.get("/peer/peers", async () => ({
  peers: getPeersForExchange(50),
}));

server.post("/peer/announce", async (req, reply) => {
  const ann = req.body;
  if (!ann || typeof ann !== "object") {
    return reply.code(400).send({ error: "Invalid body" });
  }

  // Support both new `from` field (agentId) and legacy `fromYgg` (transition)
  const senderId = ann.from ?? ann.fromYgg;
  if (!senderId) {
    return reply.code(400).send({ error: "Missing 'from' field" });
  }

  const { signature, ...signable } = ann;
  if (!verifySignature(ann.publicKey, signable, signature)) {
    return reply.code(403).send({ error: "Invalid Ed25519 signature" });
  }

  const derivedId = agentIdFromPublicKey(ann.publicKey);
  if (senderId !== derivedId) {
    // Allow legacy yggdrasil addresses that don't match the agentId derivation
    // but still passed signature verification — just use the derived agentId
    console.warn(`[bootstrap] sender id ${senderId.slice(0,16)}... != derived ${derivedId.slice(0,16)}... — using derived`);
  }

  const sharedPeers = ann.peers ?? [];

  upsertPeer(derivedId, ann.publicKey, {
    alias: ann.alias,
    version: ann.version,
    endpoints: ann.endpoints ?? [],
    source: "gossip",
    discoveredVia: derivedId,
  });

  for (const p of sharedPeers) {
    const pid = p.agentId ?? (p.yggAddr && p.publicKey ? agentIdFromPublicKey(p.publicKey) : null);
    if (!pid || pid === derivedId) continue;
    if (!p.publicKey) continue;
    upsertPeer(pid, p.publicKey, {
      alias: p.alias,
      endpoints: p.endpoints ?? [],
      source: "gossip",
      discoveredVia: derivedId,
      lastSeen: p.lastSeen,
    });
  }

  console.log(
    `[bootstrap] ↔ ${derivedId.slice(0, 16)}...  shared=${sharedPeers.length}  total=${peers.size}`
  );

  const self = {
    agentId: selfAgentId,
    publicKey: selfPubB64,
    alias: _agentName,
    version: AGENT_VERSION,
    endpoints: [],
  };
  return { ok: true, self, peers: getPeersForExchange(50) };
});

server.post("/peer/message", async (req, reply) => {
  const msg = req.body;
  if (!msg || typeof msg !== "object") {
    return reply.code(400).send({ error: "Invalid body" });
  }

  const senderId = msg.from ?? msg.fromYgg;
  if (!senderId) {
    return reply.code(400).send({ error: "Missing 'from' field" });
  }

  const { signature, ...signable } = msg;
  if (!verifySignature(msg.publicKey, signable, signature)) {
    return reply.code(403).send({ error: "Invalid Ed25519 signature" });
  }

  const derivedId = agentIdFromPublicKey(msg.publicKey);

  // TOFU: key by derived agentId
  const cachedKey = tofuCache.get(derivedId);
  if (cachedKey && cachedKey !== msg.publicKey) {
    return reply.code(403).send({ error: "Public key mismatch (TOFU)" });
  }
  tofuCache.set(derivedId, msg.publicKey);

  if (msg.event === "leave") {
    peers.delete(derivedId);
    return { ok: true };
  }

  console.log(`[bootstrap] ← message from=${derivedId.slice(0, 16)}... event=${msg.event}`);

  if (!checkRateLimit(derivedId)) {
    const retryAfterSec = Math.ceil(RATE_LIMIT_WINDOW_MS / 1000);
    console.log(`[bootstrap] rate-limited ${derivedId.slice(0, 16)}...`);
    reply.header("Retry-After", String(retryAfterSec));
    return reply.code(429).send({ error: "Rate limit exceeded", retryAfterSec });
  }

  reply.send({ ok: true });

  const replyText = await callKimi(msg.content);
  if (replyText) {
    const peer = peers.get(derivedId);
    if (peer?.endpoints?.length) {
      await sendMessageToEndpoints(peer.endpoints, replyText);
    }
  }
});

// ---------------------------------------------------------------------------
// UDP peer registry for QUIC/UDP rendezvous (port 8098)
// ---------------------------------------------------------------------------
const udpPeers = new Map(); // agentId -> { agentId, publicKey, address, port, lastSeen }
const UDP_PEER_TTL_MS = 10 * 60 * 1000;

function pruneUdpPeers() {
  const cutoff = Date.now() - UDP_PEER_TTL_MS;
  for (const [id, p] of udpPeers) {
    if (p.lastSeen < cutoff) udpPeers.delete(id);
  }
}

server.get("/peer/udp-peers", async () => {
  pruneUdpPeers();
  return {
    peers: Array.from(udpPeers.values()).map(p => ({
      agentId: p.agentId,
      address: p.address,
      port: p.port,
      lastSeen: p.lastSeen,
    })),
  };
});

await loadKimiKey();
await server.listen({ port: PORT, host: "::" });
console.log(`[bootstrap] Listening on [::]:${PORT}${TEST_MODE ? " (test mode)" : ""}`);
console.log(`[bootstrap] Agent ID: ${selfAgentId}`);
console.log(`[bootstrap] Data dir: ${DATA_DIR}`);

// ---------------------------------------------------------------------------
// UDP socket for QUIC peer rendezvous (port 8098)
// ---------------------------------------------------------------------------
const udpServer = dgram.createSocket("udp6");

udpServer.on("error", (err) => {
  console.error("[udp] server error:", err.message);
});

udpServer.on("message", (msg, rinfo) => {
  pruneUdpPeers();

  let data;
  try {
    data = JSON.parse(msg.toString("utf-8"));
  } catch {
    return;
  }

  if (!data || !data.agentId || data.type !== "announce") return;

  const senderEndpoint = `${rinfo.address}:${rinfo.port}`;
  udpPeers.set(data.agentId, {
    agentId: data.agentId,
    publicKey: data.publicKey ?? "",
    address: rinfo.address,
    port: rinfo.port,
    lastSeen: Date.now(),
  });

  const peerList = Array.from(udpPeers.values())
    .filter(p => p.agentId !== data.agentId)
    .slice(0, 20)
    .map(p => ({ agentId: p.agentId, address: p.address, port: p.port }));

  const reply = Buffer.from(JSON.stringify({
    ok: true,
    yourEndpoint: senderEndpoint,
    peers: peerList,
  }));

  udpServer.send(reply, rinfo.port, rinfo.address, (err) => {
    if (err) console.warn("[udp] reply error:", err.message);
  });

  console.log(`[udp] announce from ${senderEndpoint} agentId=${data.agentId.slice(0, 16)}...`);
});

udpServer.bind(8098, "::", () => {
  console.log("[udp] Listening on [::]:8098");
});

// ---------------------------------------------------------------------------
// Periodic sync with sibling bootstrap nodes (pull model via bootstrap.json)
// ---------------------------------------------------------------------------
const BOOTSTRAP_JSON_URL =
  "https://resciencelab.github.io/DAP/bootstrap.json";
const SYNC_INTERVAL_MS = parseInt(process.env.SYNC_INTERVAL_MS ?? String(5 * 60 * 1000));

async function fetchSiblingEndpoints() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const resp = await fetch(BOOTSTRAP_JSON_URL, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.bootstrap_nodes ?? [])
      .filter((n) => n.addr)
      .map((n) => ({ addr: n.addr, port: n.httpPort ?? n.port ?? 8099 }));
  } catch {
    return [];
  }
}

async function syncWithSiblings() {
  const siblings = await fetchSiblingEndpoints();
  if (siblings.length === 0) {
    console.log("[bootstrap:sync] No sibling endpoints in bootstrap.json — skipping");
    return;
  }

  const myPeers = getPeersForExchange(50);
  const signable = {
    from: selfAgentId,
    publicKey: selfPubB64,
    alias: _agentName,
    version: AGENT_VERSION,
    timestamp: Date.now(),
    endpoints: [],
    peers: myPeers,
  };
  const sig = nacl.sign.detached(
    Buffer.from(JSON.stringify(canonicalize(signable))),
    selfKeypair.secretKey
  );
  const announcement = { ...signable, signature: Buffer.from(sig).toString("base64") };

  let ok = 0;
  for (const { addr, port } of siblings) {
    const isIpv6 = addr.includes(":") && !addr.includes(".");
    const url = isIpv6
      ? `http://[${addr}]:${port}/peer/announce`
      : `http://${addr}:${port}/peer/announce`;

    // Skip ourselves
    if (addr === process.env.PUBLIC_ADDR) continue;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(announcement),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) {
        const body = await res.json();
        if (body.self?.agentId && body.self?.publicKey) {
          upsertPeer(body.self.agentId, body.self.publicKey, {
            alias: body.self.alias,
            version: body.self.version,
            endpoints: body.self.endpoints ?? [],
            source: "gossip",
            discoveredVia: body.self.agentId,
          });
        }
        for (const p of body.peers ?? []) {
          if (!p.agentId || p.agentId === selfAgentId) continue;
          upsertPeer(p.agentId, p.publicKey, {
            alias: p.alias,
            version: p.version,
            endpoints: p.endpoints ?? [],
            source: "gossip",
            discoveredVia: body.self?.agentId,
            lastSeen: p.lastSeen,
          });
        }
        ok++;
      }
    } catch {}
  }
  console.log(`[bootstrap:sync] Synced with ${ok}/${siblings.length} siblings — total peers: ${peers.size}`);
}

// Initial sync after 10s, then every SYNC_INTERVAL_MS
setTimeout(syncWithSiblings, 10_000);
setInterval(syncWithSiblings, SYNC_INTERVAL_MS);
console.log(`[bootstrap] Sibling sync enabled (interval: ${SYNC_INTERVAL_MS / 1000}s)`);
