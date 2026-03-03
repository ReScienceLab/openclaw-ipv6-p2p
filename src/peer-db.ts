/**
 * Local peer store with TOFU (Trust On First Use) logic.
 * Persisted as a simple JSON file — no native dependencies required.
 */
import * as fs from "fs";
import * as path from "path";
import { PeerRecord, DiscoveredPeerRecord } from "./types";

interface PeerStore {
  peers: Record<string, DiscoveredPeerRecord>;
}

let dbPath: string;
let store: PeerStore = { peers: {} };
let _saveTimer: ReturnType<typeof setTimeout> | null = null;
const SAVE_DEBOUNCE_MS = 1000;

function load(): void {
  if (fs.existsSync(dbPath)) {
    try {
      store = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
    } catch {
      store = { peers: {} };
    }
  }
}

function saveImmediate(): void {
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
  fs.writeFileSync(dbPath, JSON.stringify(store, null, 2));
}

function save(): void {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    fs.writeFileSync(dbPath, JSON.stringify(store, null, 2));
  }, SAVE_DEBOUNCE_MS);
}

export function flushDb(): void {
  if (_saveTimer) saveImmediate();
}

export function initDb(dataDir: string): void {
  dbPath = path.join(dataDir, "peers.json");
  load();
}

export function listPeers(): DiscoveredPeerRecord[] {
  return Object.values(store.peers).sort((a, b) => b.lastSeen - a.lastSeen);
}

export function upsertPeer(yggAddr: string, alias: string = ""): void {
  const now = Date.now();
  const existing = store.peers[yggAddr];
  if (existing) {
    existing.alias = alias || existing.alias;
    existing.lastSeen = now;
  } else {
    store.peers[yggAddr] = { yggAddr, publicKey: "", alias, firstSeen: now, lastSeen: now, source: "manual" };
  }
  saveImmediate();
}

/**
 * Upsert a peer discovered via bootstrap or gossip.
 * Never overwrites a manually-added peer's alias or source.
 *
 * Provenance rule: if `lastSeen` is provided (gossip path), preserve the original
 * timestamp — only advance if newer, never push to now based on indirect info.
 * If `lastSeen` is omitted (direct contact path), update to now.
 */
export function upsertDiscoveredPeer(
  yggAddr: string,
  publicKey: string,
  opts: { alias?: string; version?: string; discoveredVia?: string; source?: "bootstrap" | "gossip"; lastSeen?: number } = {}
): void {
  const now = Date.now();
  const existing = store.peers[yggAddr];
  if (existing) {
    if (!existing.publicKey) existing.publicKey = publicKey;
    if (opts.lastSeen !== undefined) {
      existing.lastSeen = Math.max(existing.lastSeen, opts.lastSeen);
    } else {
      existing.lastSeen = now;
    }
    if (!existing.discoveredVia) existing.discoveredVia = opts.discoveredVia;
    if (opts.version) existing.version = opts.version;
    // Refresh remote-declared name for non-manual peers
    if (opts.alias && existing.source !== "manual") existing.alias = opts.alias;
  } else {
    store.peers[yggAddr] = {
      yggAddr,
      publicKey,
      alias: opts.alias ?? "",
      version: opts.version,
      firstSeen: now,
      lastSeen: opts.lastSeen ?? now,
      source: opts.source ?? "gossip",
      discoveredVia: opts.discoveredVia,
    };
  }
  save();
}

/** Return peers suitable for sharing during peer exchange (max N, most recently seen). */
export function getPeersForExchange(max: number = 20): DiscoveredPeerRecord[] {
  return Object.values(store.peers)
    .filter((p) => p.publicKey) // only share peers we have a public key for
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, max);
}

export function removePeer(yggAddr: string): void {
  delete store.peers[yggAddr];
  saveImmediate();
}

export function getPeer(yggAddr: string): PeerRecord | null {
  return store.peers[yggAddr] ?? null;
}

export function getPeerAddresses(): string[] {
  return Object.keys(store.peers);
}

/**
 * Remove peers whose lastSeen is older than maxAgeMs.
 * Skips manually-added peers and any address in protectedAddrs (e.g. bootstrap nodes).
 * Returns the count of pruned peers.
 */
export function pruneStale(maxAgeMs: number, protectedAddrs: string[] = []): number {
  const cutoff = Date.now() - maxAgeMs;
  let pruned = 0;
  for (const addr of Object.keys(store.peers)) {
    const record = store.peers[addr];
    if (record.source === "manual") continue;
    if (protectedAddrs.includes(addr)) continue;
    if (record.lastSeen < cutoff) {
      delete store.peers[addr];
      pruned++;
    }
  }
  if (pruned > 0) {
    console.log(`[p2p:db] Pruned ${pruned} stale peer(s)`);
    saveImmediate();
  }
  return pruned;
}

/**
 * TOFU: on first message from a peer, cache their public key.
 * On subsequent messages the key must match. Returns false if mismatched.
 */
export function toufuVerifyAndCache(yggAddr: string, publicKey: string): boolean {
  const now = Date.now();
  const existing = store.peers[yggAddr];

  if (!existing) {
    // Unknown peer — TOFU: accept and cache
    store.peers[yggAddr] = { yggAddr, publicKey, alias: "", firstSeen: now, lastSeen: now, source: "gossip" };
    saveImmediate();
    return true;
  }

  if (!existing.publicKey) {
    // Known address (manually added) but no key yet — cache now
    existing.publicKey = publicKey;
    existing.lastSeen = now;
    saveImmediate();
    return true;
  }

  if (existing.publicKey !== publicKey) {
    return false; // Key mismatch — reject
  }

  existing.lastSeen = now;
  save();
  return true;
}
