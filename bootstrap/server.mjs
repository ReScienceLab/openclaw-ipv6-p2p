/**
 * DeClaw Bootstrap Node — standalone peer exchange server.
 * No OpenClaw dependency. Runs alongside a Yggdrasil daemon.
 *
 * Endpoints:
 *   GET  /peer/ping     — health check
 *   GET  /peer/peers    — return known peer list
 *   POST /peer/announce — accept signed peer announcement, return our peer list
 */
import Fastify from "fastify";
import nacl from "tweetnacl";
import fs from "fs";
import path from "path";

const PORT = parseInt(process.env.PEER_PORT ?? "8099");
const DATA_DIR = process.env.DATA_DIR ?? "/data";
const TEST_MODE = process.env.TEST_MODE === "true";
const MAX_PEERS = 500;
const AGENT_VERSION = process.env.AGENT_VERSION ?? "1.0.0";
const PERSIST_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Peer DB (in-memory + JSON persistence)
// ---------------------------------------------------------------------------
const peers = new Map(); // yggAddr -> PeerRecord

function loadPeers() {
  const file = path.join(DATA_DIR, "peers.json");
  if (!fs.existsSync(file)) return;
  try {
    const records = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const r of records) peers.set(r.yggAddr, r);
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
 * If omitted (direct announce path), update to now.
 */
function upsertPeer(yggAddr, publicKey, opts = {}) {
  const now = Date.now();
  const existing = peers.get(yggAddr);
  let lastSeen;
  if (opts.lastSeen !== undefined) {
    lastSeen = Math.max(existing?.lastSeen ?? 0, opts.lastSeen);
  } else {
    lastSeen = now;
  }
  peers.set(yggAddr, {
    yggAddr,
    publicKey,
    alias: opts.alias ?? existing?.alias ?? "",
    version: opts.version ?? existing?.version,
    firstSeen: existing?.firstSeen ?? now,
    lastSeen,
    source: opts.source ?? "gossip",
    discoveredVia: opts.discoveredVia ?? existing?.discoveredVia,
  });
  // Evict oldest peers if we exceed MAX_PEERS
  if (peers.size > MAX_PEERS) {
    const sorted = [...peers.values()].sort((a, b) => a.lastSeen - b.lastSeen);
    peers.delete(sorted[0].yggAddr);
  }
}

function pruneStale(maxAgeMs, protectedAddrs = []) {
  const cutoff = Date.now() - maxAgeMs;
  let pruned = 0;
  for (const [addr, record] of peers) {
    if (protectedAddrs.includes(addr)) continue;
    if (record.lastSeen < cutoff) {
      peers.delete(addr);
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
    .map(({ yggAddr, publicKey, alias, version, lastSeen }) => ({
      yggAddr,
      publicKey,
      alias,
      version,
      lastSeen,
    }));
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------
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

function isYggdrasilAddr(addr) {
  // Yggdrasil 200::/8 — first byte 0x02, compressed to "2XX:" in IPv6 text
  const clean = addr.replace(/^::ffff:/, "");
  return /^2[0-9a-f]{2}:/i.test(clean);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
fs.mkdirSync(DATA_DIR, { recursive: true });
loadPeers();
setInterval(savePeers, PERSIST_INTERVAL_MS);
// Prune peers not directly seen for 48h (protect sibling bootstrap nodes)
const STALE_TTL_MS = parseInt(process.env.STALE_TTL_MS ?? String(48 * 60 * 60 * 1000));
setInterval(() => pruneStale(STALE_TTL_MS, FALLBACK_SIBLINGS), 60 * 60 * 1000);

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

  const srcIp = req.socket.remoteAddress ?? "";

  if (!TEST_MODE) {
    if (!isYggdrasilAddr(srcIp)) {
      return reply.code(403).send({ error: "Source must be a Yggdrasil address (200::/8)" });
    }
    const normalizedSrc = srcIp.replace(/^::ffff:/, "");
    if (ann.fromYgg !== normalizedSrc) {
      return reply.code(403).send({
        error: `fromYgg ${ann.fromYgg} does not match TCP source ${normalizedSrc}`,
      });
    }
  }

  const { signature, ...signable } = ann;
  if (!verifySignature(ann.publicKey, signable, signature)) {
    return reply.code(403).send({ error: "Invalid Ed25519 signature" });
  }
  const sharedPeers = ann.peers;

  upsertPeer(ann.fromYgg, ann.publicKey, {
    alias: ann.alias,
    version: ann.version,
    source: "gossip",
    discoveredVia: ann.fromYgg,
  });

  for (const p of sharedPeers ?? []) {
    if (p.yggAddr === ann.fromYgg) continue;
    upsertPeer(p.yggAddr, p.publicKey, {
      alias: p.alias,
      source: "gossip",
      discoveredVia: ann.fromYgg,
      lastSeen: p.lastSeen,
    });
  }

  console.log(
    `[bootstrap] ↔ ${ann.fromYgg.slice(0, 22)}...  shared=${sharedPeers?.length ?? 0}  total=${peers.size}`
  );

  // Include self metadata so clients learn our name/version on first contact
  const selfYgg = _selfYggAddr;
  const self = selfYgg
    ? { yggAddr: selfYgg, publicKey: selfPubB64, alias: _agentName, version: AGENT_VERSION }
    : undefined;
  return { ok: true, ...(self ? { self } : {}), peers: getPeersForExchange(50) };
});

await server.listen({ port: PORT, host: "::" });
console.log(`[bootstrap] Listening on [::]:${PORT}${TEST_MODE ? " (test mode)" : ""}`);
console.log(`[bootstrap] Data dir: ${DATA_DIR}`);

// ---------------------------------------------------------------------------
// Periodic sync with sibling bootstrap nodes
// ---------------------------------------------------------------------------
const BOOTSTRAP_JSON_URL =
  "https://resciencelab.github.io/DeClaw/bootstrap.json";
const SYNC_INTERVAL_MS = parseInt(process.env.SYNC_INTERVAL_MS ?? String(5 * 60 * 1000));

// Generate a persistent identity for this bootstrap node
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
let _selfYggAddr = null;
let _agentName = process.env.AGENT_NAME ?? null;

async function getSelfYggAddr() {
  try {
    const { execSync } = await import("child_process");
    const out = execSync("yggdrasilctl getSelf 2>/dev/null", { encoding: "utf8" });
    const m = out.match(/IPv6 address[^│]*│\s*(\S+)/);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

const FALLBACK_SIBLINGS = [
  "200:697f:bda:1e8e:706a:6c5e:630b:51d",
  "200:e1a5:b063:958:8f74:ec45:8eb0:e30e",
  "200:9cf6:eaf1:7d3e:14b0:5869:2140:b618",
  "202:adbc:dde1:e272:1cdb:97d0:8756:4f77",
  "200:5ec6:62dd:9e91:3752:820c:98f5:5863",
];

async function fetchSiblingAddrs() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const resp = await fetch(BOOTSTRAP_JSON_URL, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) return FALLBACK_SIBLINGS;
    const data = await resp.json();
    const addrs = (data.bootstrap_nodes ?? []).map((n) => n.yggAddr);
    return addrs.length > 0 ? addrs : FALLBACK_SIBLINGS;
  } catch { return FALLBACK_SIBLINGS; }
}

async function syncWithSiblings() {
  const selfAddr = await getSelfYggAddr();
  if (!selfAddr) {
    console.warn("[bootstrap:sync] Could not determine own Yggdrasil address — skipping");
    return;
  }
  // Cache for /peer/announce response self metadata
  _selfYggAddr = selfAddr;
  if (!_agentName) _agentName = `ReScience Lab's bootstrap-${selfAddr.slice(0, 12)}`;

  const siblings = (await fetchSiblingAddrs()).filter((a) => a !== selfAddr);
  if (siblings.length === 0) return;

  const myPeers = getPeersForExchange(50);
  const signable = {
    fromYgg: selfAddr,
    publicKey: selfPubB64,
    alias: _agentName,
    version: AGENT_VERSION,
    timestamp: Date.now(),
    peers: myPeers,
  };
  const msg = Buffer.from(JSON.stringify(canonicalize(signable)));
  const sig = nacl.sign.detached(msg, selfKeypair.secretKey);
  const announcement = { ...signable, signature: Buffer.from(sig).toString("base64") };

  let ok = 0;
  for (const addr of siblings) {
    try {
      const res = await fetch(`http://[${addr}]:${PORT}/peer/announce`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(announcement),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) {
        const body = await res.json();
        if (body.self?.yggAddr && body.self?.publicKey) {
          upsertPeer(body.self.yggAddr, body.self.publicKey, {
            alias: body.self.alias,
            version: body.self.version,
            source: "gossip",
            discoveredVia: body.self.yggAddr,
          });
        }
        for (const p of body.peers ?? []) {
          if (p.yggAddr === selfAddr) continue;
          upsertPeer(p.yggAddr, p.publicKey, {
            alias: p.alias,
            version: p.version,
            source: "gossip",
            discoveredVia: addr,
            lastSeen: p.lastSeen,
          });
        }
        ok++;
      }
    } catch {}
  }
  console.log(`[bootstrap:sync] Synced with ${ok}/${siblings.length} siblings — total peers: ${peers.size}`);
}

// Initial sync after 30s (let Yggdrasil routes converge), then every SYNC_INTERVAL_MS
setTimeout(syncWithSiblings, 30_000);
setInterval(syncWithSiblings, SYNC_INTERVAL_MS);
console.log(`[bootstrap] Sibling sync enabled (interval: ${SYNC_INTERVAL_MS / 1000}s)`);
