import fs from "fs"
import path from "path"
import crypto from "node:crypto"
import { signWithDomainSeparator, verifyWithDomainSeparator, DOMAIN_SEPARATORS } from "./crypto.js"
import type { Identity } from "./types.js"
import type { LedgerEntry, LedgerEvent, AgentSummary, LedgerQueryOpts } from "./types.js"

const ZERO_HASH = "0".repeat(64)
const LEDGER_DOMAIN = `AgentWorld-Ledger-${DOMAIN_SEPARATORS.MESSAGE.split("-").slice(-1)[0].replace("\0", "")}`
const LEDGER_SEPARATOR = `AgentWorld-Ledger-${DOMAIN_SEPARATORS.MESSAGE.split("-")[2]}`

/**
 * Append-only event ledger for World Agent activity.
 *
 * Blockchain-inspired design:
 * - Each entry references the previous entry's hash (hash chain)
 * - Entries are signed by the world's identity (tamper-evident)
 * - State is derived from replaying the event log
 * - Persisted as JSON Lines (.jsonl) — one entry per line
 */
export class WorldLedger {
  private entries: LedgerEntry[] = []
  private filePath: string
  private identity: Identity
  private worldId: string
  /** Number of raw lines that failed to parse on load (0 = clean) */
  public corruptedLines = 0

  constructor(dataDir: string, worldId: string, identity: Identity) {
    this.filePath = path.join(dataDir, "world-ledger.jsonl")
    this.identity = identity
    this.worldId = worldId
    this.load()
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) {
      this.writeGenesis()
      return
    }

    const lines = fs.readFileSync(this.filePath, "utf8").trim().split("\n").filter(Boolean)
    let corrupted = 0
    for (const line of lines) {
      try {
        this.entries.push(JSON.parse(line) as LedgerEntry)
      } catch {
        corrupted++
      }
    }
    this.corruptedLines = corrupted

    if (corrupted > 0) {
      console.warn(`[ledger] WARNING: ${corrupted} corrupted line(s) detected in ${this.filePath}`)
    }

    if (this.entries.length === 0) {
      this.writeGenesis()
    }
  }

  private writeGenesis(): void {
    const entry = this.buildEntry("world.genesis", this.identity.agentId, undefined, {
      worldId: this.worldId,
    })
    this.entries.push(entry)
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify(entry) + "\n")
  }

  private lastHash(): string {
    if (this.entries.length === 0) return ZERO_HASH
    return this.entries[this.entries.length - 1].hash
  }

  private buildEntry(
    event: LedgerEvent,
    agentId: string,
    alias?: string,
    data?: Record<string, unknown>
  ): LedgerEntry {
    const seq = this.entries.length
    const prevHash = this.lastHash()
    const timestamp = Date.now()

    const core = { seq, prevHash, timestamp, event, agentId, ...(alias ? { alias } : {}), ...(data ? { data } : {}) }
    const hash = crypto.createHash("sha256").update(JSON.stringify(core)).digest("hex")

    const sigPayload = { ...core, hash }
    const worldSig = signWithDomainSeparator(LEDGER_SEPARATOR, sigPayload, this.identity.secretKey)

    return { ...core, hash, worldSig }
  }

  append(event: LedgerEvent, agentId: string, alias?: string, data?: Record<string, unknown>): LedgerEntry {
    const entry = this.buildEntry(event, agentId, alias, data)
    this.entries.push(entry)
    fs.appendFileSync(this.filePath, JSON.stringify(entry) + "\n")
    return entry
  }

  getEntries(opts?: LedgerQueryOpts): LedgerEntry[] {
    let result = this.entries

    if (opts?.agentId) {
      result = result.filter(e => e.agentId === opts.agentId)
    }
    if (opts?.event) {
      const events = Array.isArray(opts.event) ? opts.event : [opts.event]
      result = result.filter(e => events.includes(e.event))
    }
    if (opts?.since) {
      result = result.filter(e => e.timestamp >= opts.since!)
    }
    if (opts?.until) {
      result = result.filter(e => e.timestamp <= opts.until!)
    }
    if (opts?.limit) {
      result = result.slice(-opts.limit)
    }
    return result
  }

  /**
   * Derive agent summaries from the event log.
   *
   * @param liveAgentIds  Optional set of agent IDs currently in the live session.
   *                      When provided, `online` is true only if the agent is in this set.
   *                      When omitted, `online` is derived from the event log (may be stale after restart).
   */
  getAgentSummaries(liveAgentIds?: Set<string>): AgentSummary[] {
    const map = new Map<string, {
      agentId: string
      alias: string
      firstSeen: number
      lastSeen: number
      actions: number
      joins: number
      online: boolean
    }>()

    for (const entry of this.entries) {
      if (entry.event === "world.genesis") continue
      const id = entry.agentId
      let summary = map.get(id)
      if (!summary) {
        summary = { agentId: id, alias: "", firstSeen: entry.timestamp, lastSeen: entry.timestamp, actions: 0, joins: 0, online: false }
        map.set(id, summary)
      }

      if (entry.alias) summary.alias = entry.alias
      summary.lastSeen = entry.timestamp

      switch (entry.event) {
        case "world.join":
          summary.joins++
          summary.online = true
          break
        case "world.action":
          summary.actions++
          break
        case "world.leave":
        case "world.evict":
          summary.online = false
          break
      }
    }

    // If live session info is available, use it as the source of truth for online status
    if (liveAgentIds) {
      for (const summary of map.values()) {
        summary.online = liveAgentIds.has(summary.agentId)
      }
    }

    return [...map.values()].sort((a, b) => b.lastSeen - a.lastSeen)
  }

  /**
   * Verify the entire chain's integrity: hash chain + world signatures.
   * Returns { ok, errors } where errors lists any broken entries.
   */
  verify(): { ok: boolean; errors: Array<{ seq: number; error: string }> } {
    const errors: Array<{ seq: number; error: string }> = []

    // Detect corrupted/dropped lines from load
    if (this.corruptedLines > 0) {
      errors.push({ seq: -1, error: `${this.corruptedLines} corrupted line(s) dropped during load — possible data loss` })
    }

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]

      // Detect seq gaps (entries dropped from middle of chain)
      if (entry.seq !== i) {
        errors.push({ seq: entry.seq, error: `seq gap: expected ${i}, got ${entry.seq}` })
      }

      // Verify prevHash chain
      const expectedPrev = i === 0 ? ZERO_HASH : this.entries[i - 1].hash
      if (entry.prevHash !== expectedPrev) {
        errors.push({ seq: entry.seq, error: `prevHash mismatch: expected ${expectedPrev.slice(0, 8)}..., got ${entry.prevHash.slice(0, 8)}...` })
      }

      // Verify self-hash
      const { hash, worldSig, ...core } = entry
      const expectedHash = crypto.createHash("sha256").update(JSON.stringify(core)).digest("hex")
      if (hash !== expectedHash) {
        errors.push({ seq: entry.seq, error: "hash mismatch" })
      }

      // Verify world signature
      const sigPayload = { ...core, hash }
      const valid = verifyWithDomainSeparator(LEDGER_SEPARATOR, this.identity.pubB64, sigPayload, worldSig)
      if (!valid) {
        errors.push({ seq: entry.seq, error: "invalid worldSig" })
      }
    }

    return { ok: errors.length === 0, errors }
  }

  get length(): number {
    return this.entries.length
  }

  get head(): LedgerEntry | undefined {
    return this.entries[this.entries.length - 1]
  }
}
