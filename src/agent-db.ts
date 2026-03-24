/**
 * Local agent store with TOFU (Trust On First Use) logic.
 * Keyed by agentId.
 */
import * as fs from "fs"
import * as path from "path"
import { DiscoveredAgentRecord, Endpoint } from "./types"
import { agentIdFromPublicKey } from "./identity"

interface AgentStore {
  version: number
  agents: Record<string, DiscoveredAgentRecord>
}

let dbPath: string
let store: AgentStore = { version: 3, agents: {} }
let _saveTimer: ReturnType<typeof setTimeout> | null = null
const SAVE_DEBOUNCE_MS = 1000

function load(): void {
  if (fs.existsSync(dbPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(dbPath, "utf-8"))
      const migrated: Record<string, DiscoveredAgentRecord> = {}
      for (const [storedId, record] of Object.entries(raw.agents ?? raw.peers ?? {})) {
        const r = record as DiscoveredAgentRecord
        // Migrate legacy 32-char truncated agentIds → aw:sha256:<64hex>
        if (/^[0-9a-f]{32}$/.test(storedId) && r.publicKey) {
          const newId = agentIdFromPublicKey(r.publicKey)
          migrated[newId] = { ...r, agentId: newId }
        } else {
          migrated[storedId] = r
        }
      }
      store = { version: 3, agents: migrated }
    } catch {
      store = { version: 3, agents: {} }
    }
  } else {
    store = { version: 3, agents: {} }
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
  dbPath = path.join(dataDir, "agents.json")
  load()
}

export function listAgents(): DiscoveredAgentRecord[] {
  return Object.values(store.agents).sort((a, b) => b.lastSeen - a.lastSeen)
}

export function upsertAgent(agentId: string, alias: string = ""): void {
  const now = Date.now()
  const existing = store.agents[agentId]
  if (existing) {
    existing.alias = alias || existing.alias
    existing.lastSeen = now
  } else {
    store.agents[agentId] = {
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

export function upsertDiscoveredAgent(
  agentId: string,
  publicKey: string,
  opts: {
    alias?: string
    version?: string
    discoveredVia?: string
    source?: "bootstrap" | "gossip" | "gateway"
    lastSeen?: number
    endpoints?: Endpoint[]
    capabilities?: string[]
  } = {}
): void {
  const now = Date.now()
  const existing = store.agents[agentId]
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
    store.agents[agentId] = {
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

export function getAgentsForExchange(max: number = 20): DiscoveredAgentRecord[] {
  return Object.values(store.agents)
    .filter((p) => p.publicKey)
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, max)
}

export function removeAgent(agentId: string): void {
  delete store.agents[agentId]
  saveImmediate()
}

export function getAgent(agentId: string): DiscoveredAgentRecord | null {
  return store.agents[agentId] ?? null
}

export function getAgentIds(): string[] {
  return Object.keys(store.agents)
}

export function pruneStale(maxAgeMs: number, protectedIds: string[] = []): number {
  const cutoff = Date.now() - maxAgeMs
  let pruned = 0
  for (const [id, record] of Object.entries(store.agents)) {
    if (record.source === "manual") continue
    if (protectedIds.includes(id)) continue
    if (record.lastSeen < cutoff) {
      delete store.agents[id]
      pruned++
    }
  }
  if (pruned > 0) {
    console.log(`[awn:db] Pruned ${pruned} stale agent(s)`)
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
  const existing = store.agents[agentId]

  if (!existing) {
    store.agents[agentId] = {
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
    console.log(`[awn:db] TOFU TTL expired for ${agentId} — accepting new key`)
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
  const existing = store.agents[agentId]
  if (existing) {
    existing.publicKey = newPublicKey
    existing.tofuCachedAt = now
    existing.lastSeen = now
  } else {
    store.agents[agentId] = {
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

/** Extract a reachable address from an agent's endpoints for a given transport. */
export function getEndpointAddress(agent: DiscoveredAgentRecord, transport: string): string | null {
  const ep = agent.endpoints
    ?.filter((e) => e.transport === transport)
    .sort((a, b) => a.priority - b.priority)[0]
  return ep?.address ?? null
}

/**
 * Find agents that have a matching capability.
 * - Prefix match (cap ends with ":"): "world:" matches "world:pixel-city", "world:dungeon", etc.
 * - Exact match (cap has no trailing ":"): "world:pixel-city" matches only "world:pixel-city".
 * Returns agents sorted by lastSeen descending.
 */
export function findAgentsByCapability(cap: string): DiscoveredAgentRecord[] {
  const isPrefix = cap.endsWith(":")
  return Object.values(store.agents)
    .filter((p) => p.capabilities?.some((c) => isPrefix ? c.startsWith(cap) : c === cap))
    .sort((a, b) => b.lastSeen - a.lastSeen)
}
