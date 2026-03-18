import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "fs"
import path from "path"
import os from "os"
import { WorldLedger } from "../packages/agent-world-sdk/dist/world-ledger.js"
import { loadOrCreateIdentity } from "../packages/agent-world-sdk/dist/identity.js"

let tmpDir
let identity

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-test-"))
  identity = loadOrCreateIdentity(tmpDir, "test-identity")
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("WorldLedger", () => {
  it("creates genesis entry on first init", () => {
    const ledger = new WorldLedger(tmpDir, "test-world", identity)
    assert.equal(ledger.length, 1)
    const entries = ledger.getEntries()
    assert.equal(entries[0].event, "world.genesis")
    assert.equal(entries[0].seq, 0)
    assert.equal(entries[0].prevHash, "0".repeat(64))
    assert.equal(entries[0].agentId, identity.agentId)
    assert.ok(entries[0].data?.worldId, "genesis should contain worldId")
    assert.ok(entries[0].hash)
    assert.ok(entries[0].worldSig)
  })

  it("appends join/action/leave events with hash chain", () => {
    const ledger = new WorldLedger(tmpDir, "test-world", identity)
    const agentId = "aw:sha256:aabbccdd"

    const joinEntry = ledger.append("world.join", agentId, "TestBot")
    assert.equal(joinEntry.seq, 1)
    assert.equal(joinEntry.event, "world.join")
    assert.equal(joinEntry.agentId, agentId)
    assert.equal(joinEntry.alias, "TestBot")
    assert.equal(joinEntry.prevHash, ledger.getEntries()[0].hash)

    const actionEntry = ledger.append("world.action", agentId, undefined, { action: "move" })
    assert.equal(actionEntry.seq, 2)
    assert.equal(actionEntry.prevHash, joinEntry.hash)
    assert.deepEqual(actionEntry.data, { action: "move" })

    const leaveEntry = ledger.append("world.leave", agentId)
    assert.equal(leaveEntry.seq, 3)
    assert.equal(leaveEntry.prevHash, actionEntry.hash)

    assert.equal(ledger.length, 4)
  })

  it("persists to disk and reloads on new instance", () => {
    const ledger1 = new WorldLedger(tmpDir, "test-world", identity)
    ledger1.append("world.join", "aw:sha256:agent1", "Alpha")
    ledger1.append("world.action", "aw:sha256:agent1", undefined, { action: "attack" })
    assert.equal(ledger1.length, 3)

    const ledger2 = new WorldLedger(tmpDir, "test-world", identity)
    assert.equal(ledger2.length, 3)
    const entries = ledger2.getEntries()
    assert.equal(entries[0].event, "world.genesis")
    assert.equal(entries[1].event, "world.join")
    assert.equal(entries[1].alias, "Alpha")
    assert.equal(entries[2].event, "world.action")
  })

  it("verify() passes on valid chain", () => {
    const ledger = new WorldLedger(tmpDir, "test-world", identity)
    ledger.append("world.join", "aw:sha256:a1", "Bot1")
    ledger.append("world.action", "aw:sha256:a1")
    ledger.append("world.leave", "aw:sha256:a1")

    const result = ledger.verify()
    assert.equal(result.ok, true)
    assert.equal(result.errors.length, 0)
  })

  it("verify() detects tampered entry on reload", () => {
    const ledger1 = new WorldLedger(tmpDir, "test-world", identity)
    ledger1.append("world.join", "aw:sha256:a1", "Bot1")

    // Tamper with the file: change the alias in the second line
    const filePath = path.join(tmpDir, "world-ledger.jsonl")
    const lines = fs.readFileSync(filePath, "utf8").trim().split("\n")
    const entry = JSON.parse(lines[1])
    entry.alias = "TAMPERED"
    lines[1] = JSON.stringify(entry)
    fs.writeFileSync(filePath, lines.join("\n") + "\n")

    const ledger2 = new WorldLedger(tmpDir, "test-world", identity)
    const result = ledger2.verify()
    assert.equal(result.ok, false)
    assert.ok(result.errors.length > 0)
  })

  it("getAgentSummaries() derives correct state from events", () => {
    const ledger = new WorldLedger(tmpDir, "test-world", identity)
    const a1 = "aw:sha256:agent1"
    const a2 = "aw:sha256:agent2"

    ledger.append("world.join", a1, "Alpha")
    ledger.append("world.join", a2, "Beta")
    ledger.append("world.action", a1, undefined, { action: "move" })
    ledger.append("world.action", a1, undefined, { action: "attack" })
    ledger.append("world.action", a2, undefined, { action: "defend" })
    ledger.append("world.leave", a2)

    const summaries = ledger.getAgentSummaries()
    assert.equal(summaries.length, 2)

    const alpha = summaries.find(s => s.agentId === a1)
    assert.ok(alpha)
    assert.equal(alpha.alias, "Alpha")
    assert.equal(alpha.joins, 1)
    assert.equal(alpha.actions, 2)
    assert.equal(alpha.online, true)

    const beta = summaries.find(s => s.agentId === a2)
    assert.ok(beta)
    assert.equal(beta.alias, "Beta")
    assert.equal(beta.joins, 1)
    assert.equal(beta.actions, 1)
    assert.equal(beta.online, false)
  })

  it("getAgentSummaries() tracks re-joins", () => {
    const ledger = new WorldLedger(tmpDir, "test-world", identity)
    const a1 = "aw:sha256:agent1"

    ledger.append("world.join", a1, "Alpha")
    ledger.append("world.leave", a1)
    ledger.append("world.join", a1, "Alpha v2")

    const summaries = ledger.getAgentSummaries()
    const alpha = summaries.find(s => s.agentId === a1)
    assert.equal(alpha.joins, 2)
    assert.equal(alpha.online, true)
    assert.equal(alpha.alias, "Alpha v2")
  })

  it("getEntries() supports filtering by agentId", () => {
    const ledger = new WorldLedger(tmpDir, "test-world", identity)
    ledger.append("world.join", "aw:sha256:a1", "Alpha")
    ledger.append("world.join", "aw:sha256:a2", "Beta")
    ledger.append("world.action", "aw:sha256:a1")

    const filtered = ledger.getEntries({ agentId: "aw:sha256:a1" })
    assert.equal(filtered.length, 2)
    assert.ok(filtered.every(e => e.agentId === "aw:sha256:a1"))
  })

  it("getEntries() supports filtering by event type", () => {
    const ledger = new WorldLedger(tmpDir, "test-world", identity)
    ledger.append("world.join", "aw:sha256:a1")
    ledger.append("world.action", "aw:sha256:a1")
    ledger.append("world.leave", "aw:sha256:a1")

    const joins = ledger.getEntries({ event: "world.join" })
    assert.equal(joins.length, 1)

    const multi = ledger.getEntries({ event: ["world.join", "world.leave"] })
    assert.equal(multi.length, 2)
  })

  it("getEntries() supports limit (returns last N)", () => {
    const ledger = new WorldLedger(tmpDir, "test-world", identity)
    for (let i = 0; i < 10; i++) {
      ledger.append("world.action", "aw:sha256:a1")
    }
    const last3 = ledger.getEntries({ limit: 3 })
    assert.equal(last3.length, 3)
    assert.equal(last3[0].seq, 8)
  })

  it("head returns the last entry", () => {
    const ledger = new WorldLedger(tmpDir, "test-world", identity)
    const entry = ledger.append("world.join", "aw:sha256:a1", "Alpha")
    assert.equal(ledger.head?.hash, entry.hash)
  })

  it("evict event is recorded properly", () => {
    const ledger = new WorldLedger(tmpDir, "test-world", identity)
    ledger.append("world.join", "aw:sha256:a1", "Alpha")
    ledger.append("world.evict", "aw:sha256:a1", undefined, { reason: "idle" })

    const summaries = ledger.getAgentSummaries()
    const alpha = summaries.find(s => s.agentId === "aw:sha256:a1")
    assert.equal(alpha.online, false)

    const evicts = ledger.getEntries({ event: "world.evict" })
    assert.equal(evicts.length, 1)
    assert.deepEqual(evicts[0].data, { reason: "idle" })
  })

  it("each entry hash is unique", () => {
    const ledger = new WorldLedger(tmpDir, "test-world", identity)
    ledger.append("world.join", "aw:sha256:a1")
    ledger.append("world.join", "aw:sha256:a2")
    ledger.append("world.action", "aw:sha256:a1")

    const hashes = ledger.getEntries().map(e => e.hash)
    const uniqueHashes = new Set(hashes)
    assert.equal(uniqueHashes.size, hashes.length)
  })

  it("verify() detects corrupted/truncated lines on load", () => {
    const ledger1 = new WorldLedger(tmpDir, "test-world", identity)
    ledger1.append("world.join", "aw:sha256:a1", "Bot1")
    assert.equal(ledger1.length, 2)

    // Append a corrupted line to the file
    const filePath = path.join(tmpDir, "world-ledger.jsonl")
    fs.appendFileSync(filePath, '{"broken":true, invalid json\n')

    const ledger2 = new WorldLedger(tmpDir, "test-world", identity)
    assert.equal(ledger2.corruptedLines, 1)
    assert.equal(ledger2.length, 2) // corrupted line dropped

    const result = ledger2.verify()
    assert.equal(result.ok, false)
    assert.ok(result.errors.some(e => e.error.includes("corrupted")))
  })

  it("getAgentSummaries() uses liveAgentIds to determine online status", () => {
    const ledger = new WorldLedger(tmpDir, "test-world", identity)
    const a1 = "aw:sha256:agent1"
    const a2 = "aw:sha256:agent2"

    ledger.append("world.join", a1, "Alpha")
    ledger.append("world.join", a2, "Beta")

    // Without liveAgentIds — both online from log
    const all = ledger.getAgentSummaries()
    assert.equal(all.find(s => s.agentId === a1).online, true)
    assert.equal(all.find(s => s.agentId === a2).online, true)

    // With liveAgentIds — only a1 is actually online
    const live = new Set([a1])
    const filtered = ledger.getAgentSummaries(live)
    assert.equal(filtered.find(s => s.agentId === a1).online, true)
    assert.equal(filtered.find(s => s.agentId === a2).online, false)

    // After restart — empty live set
    const empty = new Set()
    const restarted = ledger.getAgentSummaries(empty)
    assert.equal(restarted.find(s => s.agentId === a1).online, false)
    assert.equal(restarted.find(s => s.agentId === a2).online, false)
  })
})
