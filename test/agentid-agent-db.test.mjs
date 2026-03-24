import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { initDb, upsertAgent, upsertDiscoveredAgent, listAgents, getAgent, removeAgent, flushDb, tofuVerifyAndCache, tofuReplaceKey, setTofuTtl, getAgentIds, pruneStale, getEndpointAddress, findAgentsByCapability } from "../dist/agent-db.js"
import { generateIdentity } from "../dist/identity.js"

let tmpDir

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "awn-peerdb-"))
  initDb(tmpDir)
})

afterEach(() => {
  flushDb()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("peer-db (agentId-keyed)", () => {
  it("upsertDiscoveredAgent stores by agentId", () => {
    const id = generateIdentity()
    upsertDiscoveredAgent(id.agentId, id.publicKey, { source: "gateway" })
    const peer = getAgent(id.agentId)
    assert.ok(peer)
    assert.equal(peer.agentId, id.agentId)
    assert.equal(peer.publicKey, id.publicKey)
  })

  it("getAgentIds returns agentIds", () => {
    const id1 = generateIdentity()
    const id2 = generateIdentity()
    upsertDiscoveredAgent(id1.agentId, id1.publicKey, { source: "gateway" })
    upsertDiscoveredAgent(id2.agentId, id2.publicKey, { source: "gossip" })
    const ids = getAgentIds()
    assert.ok(ids.includes(id1.agentId))
    assert.ok(ids.includes(id2.agentId))
  })

  it("upsertAgent works with agentId", () => {
    upsertAgent("abcdef1234567890", "Alice")
    const peer = getAgent("abcdef1234567890")
    assert.ok(peer)
    assert.equal(peer.alias, "Alice")
  })

  it("removeAgent works with agentId", () => {
    const id = generateIdentity()
    upsertDiscoveredAgent(id.agentId, id.publicKey, {})
    assert.ok(getAgent(id.agentId))
    removeAgent(id.agentId)
    assert.equal(getAgent(id.agentId), null)
  })

  it("TOFU: tofuVerifyAndCache accepts first key", () => {
    const id = generateIdentity()
    assert.equal(tofuVerifyAndCache(id.agentId, id.publicKey), true)
  })

  it("TOFU: rejects different key for same agentId", () => {
    const id1 = generateIdentity()
    const id2 = generateIdentity()
    tofuVerifyAndCache(id1.agentId, id1.publicKey)
    assert.equal(tofuVerifyAndCache(id1.agentId, id2.publicKey), false)
  })

  it("pruneStale removes old peers but protects manual", () => {
    const id1 = generateIdentity()
    const id2 = generateIdentity()
    upsertDiscoveredAgent(id1.agentId, id1.publicKey, {
      source: "gossip",
      lastSeen: 1000,
    })
    upsertAgent(id2.agentId, "Manual")

    assert.equal(listAgents().length, 2)
    const pruned = pruneStale(1000)
    assert.ok(pruned >= 1)
    assert.equal(getAgent(id1.agentId), null)
    assert.ok(getAgent(id2.agentId))
  })

  it("TOFU: tofuCachedAt is set on first cache", () => {
    const id = generateIdentity()
    const before = Date.now()
    tofuVerifyAndCache(id.agentId, id.publicKey)
    const peer = getAgent(id.agentId)
    assert.ok(peer)
    assert.ok(typeof peer.tofuCachedAt === "number")
    assert.ok(peer.tofuCachedAt >= before)
  })

  it("TOFU TTL: accepts new key after expiry", () => {
    const id1 = generateIdentity()
    const id2 = generateIdentity()

    // Set a very short TTL (1ms) for testing
    setTofuTtl(1 / (24 * 60 * 60 * 1000)) // 1ms expressed in days

    // Cache first key
    assert.equal(tofuVerifyAndCache(id1.agentId, id1.publicKey), true)

    // Backdate tofuCachedAt to simulate expiry
    const peer = getAgent(id1.agentId)
    peer.tofuCachedAt = Date.now() - 100 // 100ms ago, well past 1ms TTL

    // A different key should now be accepted
    assert.equal(tofuVerifyAndCache(id1.agentId, id2.publicKey), true)
    const updated = getAgent(id1.agentId)
    assert.equal(updated.publicKey, id2.publicKey)

    // Restore default TTL
    setTofuTtl(7)
  })

  it("TOFU TTL: rejects new key before expiry", () => {
    const id1 = generateIdentity()
    const id2 = generateIdentity()

    // Set a long TTL (100 days)
    setTofuTtl(100)

    assert.equal(tofuVerifyAndCache(id1.agentId, id1.publicKey), true)

    // Key is fresh — different key must be rejected
    assert.equal(tofuVerifyAndCache(id1.agentId, id2.publicKey), false)

    // Restore default TTL
    setTofuTtl(7)
  })

  it("tofuReplaceKey replaces existing binding", () => {
    const id1 = generateIdentity()
    const id2 = generateIdentity()

    tofuVerifyAndCache(id1.agentId, id1.publicKey)
    tofuReplaceKey(id1.agentId, id2.publicKey)

    const peer = getAgent(id1.agentId)
    assert.equal(peer.publicKey, id2.publicKey)
    assert.ok(peer.tofuCachedAt)

    // New key should now verify correctly
    assert.equal(tofuVerifyAndCache(id1.agentId, id2.publicKey), true)
  })

  it("tofuReplaceKey creates new record if peer not found", () => {
    const id = generateIdentity()
    tofuReplaceKey(id.agentId, id.publicKey)
    const peer = getAgent(id.agentId)
    assert.ok(peer)
    assert.equal(peer.publicKey, id.publicKey)
    assert.ok(peer.tofuCachedAt)
  })

  it("getEndpointAddress returns best address for transport", () => {
    const id = generateIdentity()
    upsertDiscoveredAgent(id.agentId, id.publicKey, {
      endpoints: [
        { transport: "tcp", address: "10.0.0.1", port: 8099, priority: 1, ttl: 86400 },
        { transport: "quic", address: "1.2.3.4", port: 8098, priority: 10, ttl: 3600 },
      ],
    })
    const peer = getAgent(id.agentId)
    assert.equal(getEndpointAddress(peer, "tcp"), "10.0.0.1")
    assert.equal(getEndpointAddress(peer, "quic"), "1.2.3.4")
    assert.equal(getEndpointAddress(peer, "tailscale"), null)
  })
})

describe("findAgentsByCapability", () => {
  it("exact match returns peer with that capability", () => {
    const id = generateIdentity()
    upsertDiscoveredAgent(id.agentId, id.publicKey, { capabilities: ["world:pixel-city"] })
    const results = findAgentsByCapability("world:pixel-city")
    assert.equal(results.length, 1)
    assert.equal(results[0].agentId, id.agentId)
  })

  it("prefix match returns all world:* peers", () => {
    const a = generateIdentity()
    const b = generateIdentity()
    const c = generateIdentity()
    upsertDiscoveredAgent(a.agentId, a.publicKey, { capabilities: ["world:pixel-city"] })
    upsertDiscoveredAgent(b.agentId, b.publicKey, { capabilities: ["world:dungeon"] })
    upsertDiscoveredAgent(c.agentId, c.publicKey, { capabilities: ["chat"] })
    const results = findAgentsByCapability("world:")
    assert.equal(results.length, 2)
    assert.ok(results.some((p) => p.agentId === a.agentId))
    assert.ok(results.some((p) => p.agentId === b.agentId))
  })

  it("returns empty array when no match", () => {
    const id = generateIdentity()
    upsertDiscoveredAgent(id.agentId, id.publicKey, { capabilities: ["chat"] })
    assert.deepEqual(findAgentsByCapability("world:"), [])
  })

  it("peer with no capabilities is not matched", () => {
    const id = generateIdentity()
    upsertDiscoveredAgent(id.agentId, id.publicKey, {})
    assert.deepEqual(findAgentsByCapability("world:"), [])
  })
})
