import type { PeerRecord } from "./types.js"

const DEFAULT_MAX_PEERS = 200
const DEFAULT_STALE_TTL_MS = 30 * 60 * 1000

export class PeerDb {
  private peers = new Map<string, PeerRecord>()
  private maxPeers: number
  private staleTtlMs: number

  constructor(opts: { maxPeers?: number; staleTtlMs?: number } = {}) {
    this.maxPeers = opts.maxPeers ?? DEFAULT_MAX_PEERS
    this.staleTtlMs = opts.staleTtlMs ?? DEFAULT_STALE_TTL_MS
  }

  upsert(
    agentId: string,
    publicKey: string,
    opts: Partial<Omit<PeerRecord, "agentId" | "publicKey">> & { lastSeen?: number } = {}
  ): void {
    const now = Date.now()
    const existing = this.peers.get(agentId)
    const lastSeen = opts.lastSeen != null
      ? Math.max(existing?.lastSeen ?? 0, opts.lastSeen)
      : now

    this.peers.set(agentId, {
      agentId,
      publicKey: publicKey || existing?.publicKey || "",
      alias: opts.alias ?? existing?.alias ?? "",
      endpoints: opts.endpoints ?? existing?.endpoints ?? [],
      capabilities: opts.capabilities ?? existing?.capabilities ?? [],
      lastSeen,
    })

    if (this.peers.size > this.maxPeers) {
      const oldest = [...this.peers.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0]
      this.peers.delete(oldest.agentId)
    }
  }

  get(agentId: string): PeerRecord | undefined {
    return this.peers.get(agentId)
  }

  has(agentId: string): boolean {
    return this.peers.has(agentId)
  }

  prune(ttl = this.staleTtlMs): number {
    const cutoff = Date.now() - ttl
    let count = 0
    for (const [id, p] of this.peers) {
      if (p.lastSeen < cutoff) { this.peers.delete(id); count++ }
    }
    return count
  }

  getPeersForExchange(limit = 50): PeerRecord[] {
    return [...this.peers.values()]
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, limit)
      .map(({ agentId, publicKey, alias, endpoints, capabilities, lastSeen }) => ({
        agentId, publicKey, alias,
        endpoints: endpoints ?? [],
        capabilities: capabilities ?? [],
        lastSeen,
      }))
  }

  findByCapability(cap: string): PeerRecord[] {
    const isPrefix = cap.endsWith(":")
    return [...this.peers.values()]
      .filter((p) => p.capabilities?.some((c) => isPrefix ? c.startsWith(cap) : c === cap))
      .sort((a, b) => b.lastSeen - a.lastSeen)
  }

  get size(): number {
    return this.peers.size
  }

  values(): IterableIterator<PeerRecord> {
    return this.peers.values()
  }

  delete(agentId: string): void {
    this.peers.delete(agentId)
  }
}
