/**
 * Local peer store with TOFU (Trust On First Use) logic.
 * Keyed by agentId.
 */
import * as fs from "fs"
import * as path from "path"
import { DiscoveredPeerRecord, Endpoint } from "./types"
import { agentIdFromPublicKey } from "./identity"

interface PeerStore {
  version: number
  peers: Record<string, DiscoveredPeerRecord>
}

let dbPath: string
let store: PeerStore = { version: 2, peers: {} }
let _saveTimer: ReturnType<typeof setTimeout> | null = null
const SAVE_DEBOUNCE_MS = 1000

function load(): void {
  if (fs.existsSync(dbPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(dbPath, "utf-8"))
      const migrated: Record<string, DiscoveredPeerRecord> = {}
      for (const [storedId, record] of Object.entries(raw.peers ?? {})) {
        const r = record as DiscoveredPeerRecord
        // Migrate legacy 32-char truncated agentIds → aw:sha256:<64hex>
        if (/^[0-9a-f]{32}$/.test(storedId) && r.publicKey) {
          const newId = agentIdFromPublicKey(r.publicKey)
          migrated[newId] = { ...r, agentId: newId }
        } else {
          migrated[storedId] = r
        }
      }
      store = { version: 2, peers: migrated }
    } catch {
      store = { version: 2, peers: {} }
    }
  } else {
    store = { version: 2, peers: {} }
  }
}

function saveImmediate(): void {
  if (_saveTimer) {
    clearTimeout(_saveTimer)
    _saveTimer = null
  }
  fs.writeFileSync(dbPath, JSON.stringify(store, null, 2))
}

function save(): void {
  if (_saveTimer) return
  _saveTimer = setTimeout(() => {
    _saveTimer = null
    fs.writeFileSync(dbPath, JSON.stringify(store, null, 2))
  }, SAVE_DEBOUNCE_MS)
}

export function flushDb(): void {
  if (_saveTimer) saveImmediate()
}

export function initDb(dataDir: string): void {
  dbPath = path.join(dataDir, "peers.json")
  load()
}

export function listPeers(): DiscoveredPeerRecord[] {
  return Object.values(store.peers).sort((a, b) => b.lastSeen - a.lastSeen)
}

export function upsertPeer(agentId: string, alias: string = ""): void {
  const now = Date.now()
  const existing = store.peers[agentId]
  if (existing) {
    existing.alias = alias || existing.alias
    existing.lastSeen = now
  } else {
    store.peers[agentId] = {
      agentId,
      publicKey: "",
      alias,
      endpoints: [],
      capabilities: [],
      firstSeen: now,
      lastSeen: now,
      source: "manual",
    }
  }
  saveImmediate()
}

export function upsertDiscoveredPeer(
  agentId: string,
  publicKey: string,
  opts: {
    alias?: string
    version?: string
    discoveredVia?: string
    source?: "bootstrap" | "gossip"
    lastSeen?: number
    endpoints?: Endpoint[]
    capabilities?: string[]
  } = {}
): void {
  const now = Date.now()
  const existing = store.peers[agentId]
  if (existing) {
    if (!existing.publicKey) existing.publicKey = publicKey
    if (opts.lastSeen !== undefined) {
      existing.lastSeen = Math.max(existing.lastSeen, opts.lastSeen)
    } else {
      existing.lastSeen = now
    }
    if (!existing.discoveredVia) existing.discoveredVia = opts.discoveredVia
    if (opts.version) existing.version = opts.version
    if (opts.endpoints?.length) existing.endpoints = opts.endpoints
    if (opts.capabilities?.length) existing.capabilities = opts.capabilities
    if (opts.alias && existing.source !== "manual") existing.alias = opts.alias
  } else {
    store.peers[agentId] = {
      agentId,
      publicKey,
      alias: opts.alias ?? "",
      version: opts.version,
      endpoints: opts.endpoints ?? [],
      capabilities: opts.capabilities ?? [],
      firstSeen: now,
      lastSeen: opts.lastSeen ?? now,
      source: opts.source ?? "gossip",
      discoveredVia: opts.discoveredVia,
    }
  }
  save()
}

export function getPeersForExchange(max: number = 20): DiscoveredPeerRecord[] {
  return Object.values(store.peers)
    .filter((p) => p.publicKey)
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, max)
}

export function removePeer(agentId: string): void {
  delete store.peers[agentId]
  saveImmediate()
}

export function getPeer(agentId: string): DiscoveredPeerRecord | null {
  return store.peers[agentId] ?? null
}

export function getPeerIds(): string[] {
  return Object.keys(store.peers)
}

export function pruneStale(maxAgeMs: number, protectedIds: string[] = []): number {
  const cutoff = Date.now() - maxAgeMs
  let pruned = 0
  for (const [id, record] of Object.entries(store.peers)) {
    if (record.source === "manual") continue
    if (protectedIds.includes(id)) continue
    if (record.lastSeen < cutoff) {
      delete store.peers[id]
      pruned++
    }
  }
  if (pruned > 0) {
    console.log(`[p2p:db] Pruned ${pruned} stale peer(s)`)
    saveImmediate()
  }
  return pruned
}

const DEFAULT_TOFU_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

let _tofuTtlMs: number = DEFAULT_TOFU_TTL_MS

export function setTofuTtl(days: number): void {
  _tofuTtlMs = days * 24 * 60 * 60 * 1000
}

export function tofuVerifyAndCache(agentId: string, publicKey: string): boolean {
  const now = Date.now()
  const existing = store.peers[agentId]

  if (!existing) {
    store.peers[agentId] = {
      agentId,
      publicKey,
      alias: "",
      endpoints: [],
      capabilities: [],
      firstSeen: now,
      lastSeen: now,
      tofuCachedAt: now,
      source: "gossip",
    }
    saveImmediate()
    return true
  }

  if (!existing.publicKey) {
    existing.publicKey = publicKey
    existing.tofuCachedAt = now
    existing.lastSeen = now
    saveImmediate()
    return true
  }

  // TTL check: if binding has expired, accept new key as fresh TOFU
  if (existing.tofuCachedAt && now - existing.tofuCachedAt > _tofuTtlMs) {
    console.log(`[p2p:db] TOFU TTL expired for ${agentId} — accepting new key`)
    existing.publicKey = publicKey
    existing.tofuCachedAt = now
    existing.lastSeen = now
    saveImmediate()
    return true
  }

  if (existing.publicKey !== publicKey) {
    return false
  }

  existing.lastSeen = now
  if (!existing.tofuCachedAt) existing.tofuCachedAt = now
  save()
  return true
}

export function tofuReplaceKey(agentId: string, newPublicKey: string): void {
  const now = Date.now()
  const existing = store.peers[agentId]
  if (existing) {
    existing.publicKey = newPublicKey
    existing.tofuCachedAt = now
    existing.lastSeen = now
  } else {
    store.peers[agentId] = {
      agentId,
      publicKey: newPublicKey,
      alias: "",
      endpoints: [],
      capabilities: [],
      firstSeen: now,
      lastSeen: now,
      tofuCachedAt: now,
      source: "gossip",
    }
  }
  saveImmediate()
}

/** Extract a reachable address from a peer's endpoints for a given transport. */
export function getEndpointAddress(peer: DiscoveredPeerRecord, transport: string): string | null {
  const ep = peer.endpoints
    ?.filter((e) => e.transport === transport)
    .sort((a, b) => a.priority - b.priority)[0]
  return ep?.address ?? null
}

/**
 * Find peers that have a matching capability.
 * - Prefix match (cap ends with ":"): "world:" matches "world:pixel-city", "world:dungeon", etc.
 * - Exact match (cap has no trailing ":"): "world:pixel-city" matches only "world:pixel-city".
 * Returns peers sorted by lastSeen descending.
 */
export function findPeersByCapability(cap: string): DiscoveredPeerRecord[] {
  const isPrefix = cap.endsWith(":")
  return Object.values(store.peers)
    .filter((p) => p.capabilities?.some((c) => isPrefix ? c.startsWith(cap) : c === cap))
    .sort((a, b) => b.lastSeen - a.lastSeen)
}
