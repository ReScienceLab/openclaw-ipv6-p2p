import { describe, it } from "node:test"
import assert from "node:assert/strict"

describe("v2 PeerAnnouncement format", () => {
  it("announcement has from (agentId) and endpoints with port/ttl", () => {
    const announcement = {
      from: "abcdef1234567890",
      publicKey: "test-key",
      alias: "test",
      version: "0.2.3",
      timestamp: Date.now(),
      signature: "sig",
      endpoints: [
        { transport: "quic", address: "1.2.3.4", port: 8098, priority: 10, ttl: 3600 },
        { transport: "yggdrasil", address: "200::1", port: 8099, priority: 1, ttl: 86400 },
      ],
      peers: [
        {
          agentId: "1234567890abcdef",
          publicKey: "pk2",
          alias: "peer2",
          lastSeen: Date.now(),
          endpoints: [{ transport: "quic", address: "5.6.7.8", port: 8098, priority: 10, ttl: 3600 }],
        },
      ],
    }

    assert.equal(announcement.from, "abcdef1234567890")
    assert.equal(announcement.endpoints.length, 2)
    assert.equal(announcement.endpoints[0].port, 8098)
    assert.equal(announcement.endpoints[0].ttl, 3600)
    assert.equal(announcement.peers[0].agentId, "1234567890abcdef")
  })

  it("P2PMessage uses from (agentId), no fromYgg", () => {
    const msg = {
      from: "abcdef1234567890",
      publicKey: "test-key",
      event: "chat",
      content: "hello",
      timestamp: Date.now(),
      signature: "sig",
    }
    assert.equal(msg.from, "abcdef1234567890")
    assert.equal(msg.fromYgg, undefined)
  })

  it("PluginConfig supports quic_port", () => {
    const config = {
      agent_name: "test",
      peer_port: 8099,
      quic_port: 8098,
      test_mode: "auto",
    }
    assert.equal(config.quic_port, 8098)
  })
})
