import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { initDb, upsertPeer, upsertDiscoveredPeer, listPeers, getPeer, removePeer, flushDb, tofuVerifyAndCache, getPeerIds, pruneStale, getEndpointAddress } from "../dist/peer-db.js"
import { generateIdentity } from "../dist/identity.js"

let tmpDir

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "declaw-peerdb-"))
  initDb(tmpDir)
})

afterEach(() => {
  flushDb()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("peer-db (agentId-keyed)", () => {
  it("upsertDiscoveredPeer stores by agentId", () => {
    const id = generateIdentity()
    upsertDiscoveredPeer(id.agentId, id.publicKey, { source: "bootstrap" })
    const peer = getPeer(id.agentId)
    assert.ok(peer)
    assert.equal(peer.agentId, id.agentId)
    assert.equal(peer.publicKey, id.publicKey)
  })

  it("getPeerIds returns agentIds", () => {
    const id1 = generateIdentity()
    const id2 = generateIdentity()
    upsertDiscoveredPeer(id1.agentId, id1.publicKey, { source: "bootstrap" })
    upsertDiscoveredPeer(id2.agentId, id2.publicKey, { source: "gossip" })
    const ids = getPeerIds()
    assert.ok(ids.includes(id1.agentId))
    assert.ok(ids.includes(id2.agentId))
  })

  it("upsertPeer works with agentId", () => {
    upsertPeer("abcdef1234567890", "Alice")
    const peer = getPeer("abcdef1234567890")
    assert.ok(peer)
    assert.equal(peer.alias, "Alice")
  })

  it("removePeer works with agentId", () => {
    const id = generateIdentity()
    upsertDiscoveredPeer(id.agentId, id.publicKey, {})
    assert.ok(getPeer(id.agentId))
    removePeer(id.agentId)
    assert.equal(getPeer(id.agentId), null)
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
    upsertDiscoveredPeer(id1.agentId, id1.publicKey, {
      source: "gossip",
      lastSeen: 1000,
    })
    upsertPeer(id2.agentId, "Manual")

    assert.equal(listPeers().length, 2)
    const pruned = pruneStale(1000)
    assert.ok(pruned >= 1)
    assert.equal(getPeer(id1.agentId), null)
    assert.ok(getPeer(id2.agentId))
  })

  it("getEndpointAddress returns best address for transport", () => {
    const id = generateIdentity()
    upsertDiscoveredPeer(id.agentId, id.publicKey, {
      endpoints: [
        { transport: "yggdrasil", address: "200::1", port: 8099, priority: 1, ttl: 86400 },
        { transport: "quic", address: "1.2.3.4", port: 8098, priority: 10, ttl: 3600 },
      ],
    })
    const peer = getPeer(id.agentId)
    assert.equal(getEndpointAddress(peer, "yggdrasil"), "200::1")
    assert.equal(getEndpointAddress(peer, "quic"), "1.2.3.4")
    assert.equal(getEndpointAddress(peer, "tcp"), null)
  })
})
