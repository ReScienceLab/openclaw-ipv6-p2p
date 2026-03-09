import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { TransportManager } from "../dist/transport.js"

describe("TransportManager", () => {
  it("exports TransportManager class", () => {
    assert.ok(TransportManager)
    assert.equal(typeof TransportManager, "function")
  })

  it("starts with no active transport", () => {
    const tm = new TransportManager()
    assert.equal(tm.active, null)
  })

  it("returns empty endpoints when no transports registered", () => {
    const tm = new TransportManager()
    assert.deepEqual(tm.getEndpoints(), [])
  })

  it("returns empty array from getAll when no transports active", () => {
    const tm = new TransportManager()
    assert.deepEqual(tm.getAll(), [])
  })

  it("register adds transport to internal list", async () => {
    const tm = new TransportManager()
    const mock = {
      id: "quic",
      address: "",
      start: async () => false,
      stop: async () => {},
      isActive: () => false,
      send: async () => {},
      onMessage: () => {},
      getEndpoint: () => ({ transport: "quic", address: "", port: 8098, priority: 10, ttl: 3600 }),
    }
    tm.register(mock)
    // start returns null since mock transport fails
    const active = await tm.start({ agentId: "", publicKey: "", privateKey: "", cgaIpv6: "", yggIpv6: "" })
    assert.equal(active, null)
  })

  it("selects first successful transport as active", async () => {
    const tm = new TransportManager()
    const failTransport = {
      id: "yggdrasil",
      address: "",
      start: async () => false,
      stop: async () => {},
      isActive: () => false,
      send: async () => {},
      onMessage: () => {},
      getEndpoint: () => ({ transport: "yggdrasil", address: "", port: 8099, priority: 1, ttl: 86400 }),
    }
    const successTransport = {
      id: "quic",
      address: "1.2.3.4:8098",
      start: async () => true,
      stop: async () => {},
      isActive: () => true,
      send: async () => {},
      onMessage: () => {},
      getEndpoint: () => ({ transport: "quic", address: "1.2.3.4:8098", port: 8098, priority: 10, ttl: 3600 }),
    }
    tm.register(failTransport)
    tm.register(successTransport)
    const id = { agentId: "", publicKey: "", privateKey: "", cgaIpv6: "", yggIpv6: "" }
    const active = await tm.start(id)
    assert.equal(active.id, "quic")
    assert.equal(active.address, "1.2.3.4:8098")
  })

  it("returns all active transports from getAll", async () => {
    const tm = new TransportManager()
    const t1 = {
      id: "yggdrasil",
      address: "200::1",
      start: async () => true,
      stop: async () => {},
      isActive: () => true,
      send: async () => {},
      onMessage: () => {},
      getEndpoint: () => ({ transport: "yggdrasil", address: "200::1", port: 8099, priority: 1, ttl: 86400 }),
    }
    const t2 = {
      id: "quic",
      address: "1.2.3.4:8098",
      start: async () => true,
      stop: async () => {},
      isActive: () => true,
      send: async () => {},
      onMessage: () => {},
      getEndpoint: () => ({ transport: "quic", address: "1.2.3.4:8098", port: 8098, priority: 10, ttl: 3600 }),
    }
    tm.register(t1)
    tm.register(t2)
    const id = { agentId: "", publicKey: "", privateKey: "", cgaIpv6: "", yggIpv6: "" }
    await tm.start(id)
    assert.equal(tm.getAll().length, 2)
    assert.equal(tm.get("yggdrasil").id, "yggdrasil")
    assert.equal(tm.get("quic").id, "quic")
  })

  it("getEndpoints returns endpoints for all active transports", async () => {
    const tm = new TransportManager()
    const t1 = {
      id: "yggdrasil",
      address: "200::1",
      start: async () => true,
      stop: async () => {},
      isActive: () => true,
      send: async () => {},
      onMessage: () => {},
      getEndpoint: () => ({ transport: "yggdrasil", address: "200::1", port: 8099, priority: 1, ttl: 86400 }),
    }
    tm.register(t1)
    const id = { agentId: "", publicKey: "", privateKey: "", cgaIpv6: "", yggIpv6: "" }
    await tm.start(id)
    const endpoints = tm.getEndpoints()
    assert.equal(endpoints.length, 1)
    assert.equal(endpoints[0].transport, "yggdrasil")
    assert.equal(endpoints[0].address, "200::1")
    assert.equal(endpoints[0].priority, 1)
  })

  it("resolveTransport picks yggdrasil for 2xx: addresses", () => {
    const tm = new TransportManager()
    // Manually populate internal state for testing
    const ygg = {
      id: "yggdrasil",
      address: "200::1",
      start: async () => true,
      stop: async () => {},
      isActive: () => true,
      send: async () => {},
      onMessage: () => {},
      getEndpoint: () => ({ transport: "yggdrasil", address: "200::1", port: 8099, priority: 1, ttl: 86400 }),
    }
    tm.register(ygg)
    // We need to call start to populate internal maps
    tm.start({ agentId: "", publicKey: "", privateKey: "", cgaIpv6: "", yggIpv6: "" }).then(() => {
      const resolved = tm.resolveTransport("200:1234::1")
      assert.equal(resolved?.id, "yggdrasil")
    })
  })

  it("stop clears all transports", async () => {
    const tm = new TransportManager()
    let stopped = false
    const t = {
      id: "quic",
      address: "1.2.3.4:8098",
      start: async () => true,
      stop: async () => { stopped = true },
      isActive: () => true,
      send: async () => {},
      onMessage: () => {},
      getEndpoint: () => ({ transport: "quic", address: "1.2.3.4:8098", port: 8098, priority: 10, ttl: 3600 }),
    }
    tm.register(t)
    const id = { agentId: "", publicKey: "", privateKey: "", cgaIpv6: "", yggIpv6: "" }
    await tm.start(id)
    assert.equal(tm.active?.id, "quic")
    await tm.stop()
    assert.equal(tm.active, null)
    assert.equal(stopped, true)
  })
})
