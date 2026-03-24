import type { AgentRecord } from "./types.js"

const DEFAULT_MAX_PEERS = 200
const DEFAULT_STALE_TTL_MS = 30 * 60 * 1000

export class AgentDb {
  private agents = new Map<string, AgentRecord>()
  private maxPeers: number
  private staleTtlMs: number

  constructor(opts: { maxPeers?: number; staleTtlMs?: number } = {}) {
    this.maxPeers = opts.maxPeers ?? DEFAULT_MAX_PEERS
    this.staleTtlMs = opts.staleTtlMs ?? DEFAULT_STALE_TTL_MS
  }

  upsert(
    agentId: string,
    publicKey: string,
    opts: Partial<Omit<AgentRecord, "agentId" | "publicKey">> & { lastSeen?: number } = {}
  ): void {
    const now = Date.now()
    const existing = this.agents.get(agentId)
    const lastSeen = opts.lastSeen != null
      ? Math.max(existing?.lastSeen ?? 0, opts.lastSeen)
      : now

    this.agents.set(agentId, {
      agentId,
      publicKey: publicKey || existing?.publicKey || "",
      alias: opts.alias ?? existing?.alias ?? "",
      endpoints: opts.endpoints ?? existing?.endpoints ?? [],
      capabilities: opts.capabilities ?? existing?.capabilities ?? [],
      lastSeen,
    })

    if (this.agents.size > this.maxPeers) {
      const oldest = [...this.agents.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0]
      this.agents.delete(oldest.agentId)
    }
  }

  get(agentId: string): AgentRecord | undefined {
    return this.agents.get(agentId)
  }

  has(agentId: string): boolean {
    return this.agents.has(agentId)
  }

  prune(ttl = this.staleTtlMs): number {
    const cutoff = Date.now() - ttl
    let count = 0
    for (const [id, p] of this.agents) {
      if (p.lastSeen < cutoff) { this.agents.delete(id); count++ }
    }
    return count
  }

  getAgentsForExchange(limit = 50): AgentRecord[] {
    return [...this.agents.values()]
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, limit)
      .map(({ agentId, publicKey, alias, endpoints, capabilities, lastSeen }) => ({
        agentId, publicKey, alias,
        endpoints: endpoints ?? [],
        capabilities: capabilities ?? [],
        lastSeen,
      }))
  }

  findByCapability(cap: string): AgentRecord[] {
    const isPrefix = cap.endsWith(":")
    return [...this.agents.values()]
      .filter((p) => p.capabilities?.some((c) => isPrefix ? c.startsWith(cap) : c === cap))
      .sort((a, b) => b.lastSeen - a.lastSeen)
  }

  get size(): number {
    return this.agents.size
  }

  values(): IterableIterator<AgentRecord> {
    return this.agents.values()
  }

  delete(agentId: string): void {
    this.agents.delete(agentId)
  }
}
