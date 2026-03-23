import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

const MODULE_IDS = [
  "../dist/index.js",
  "../dist/identity.js",
  "../dist/peer-db.js",
  "../dist/peer-server.js",
  "../dist/peer-client.js",
  "../dist/channel.js",
  "../dist/transport.js",
  "../dist/transport-quic.js",
]

function clearModuleCache() {
  for (const moduleId of MODULE_IDS) {
    delete require.cache[require.resolve(moduleId)]
  }
}

function createHarness({
  firstRun = false,
  pingInfo = { ok: true, data: { agentId: "aw:sha256:world-host", publicKey: "d29ybGQtcHVibGljLWtleQ==" } },
  joinResponse = { ok: true, data: { worldId: "arena", manifest: { name: "Arena" }, members: [] } },
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ members: [] }) }),
} = {}) {
  clearModuleCache()

  const fs = require("node:fs")
  const childProcess = require("node:child_process")
  const identityMod = require("../dist/identity.js")
  const peerDbMod = require("../dist/peer-db.js")
  const peerServerMod = require("../dist/peer-server.js")
  const peerClientMod = require("../dist/peer-client.js")
  const channelMod = require("../dist/channel.js")
  const transportMod = require("../dist/transport.js")
  const transportQuicMod = require("../dist/transport-quic.js")

  const peers = new Map()
  const sendCalls = []
  const gatewayMessages = []
  const timers = new Map()
  const intervals = new Map()
  const fetchCalls = []
  let nextTimerId = 1

  const originals = {
    existsSync: fs.existsSync,
    execSync: childProcess.execSync,
    loadOrCreateIdentity: identityMod.loadOrCreateIdentity,
    initDb: peerDbMod.initDb,
    listPeers: peerDbMod.listPeers,
    getPeer: peerDbMod.getPeer,
    flushDb: peerDbMod.flushDb,
    getPeerIds: peerDbMod.getPeerIds,
    setTofuTtl: peerDbMod.setTofuTtl,
    findPeersByCapability: peerDbMod.findPeersByCapability,
    upsertDiscoveredPeer: peerDbMod.upsertDiscoveredPeer,
    removePeer: peerDbMod.removePeer,
    startPeerServer: peerServerMod.startPeerServer,
    stopPeerServer: peerServerMod.stopPeerServer,
    setSelfMeta: peerServerMod.setSelfMeta,
    handleUdpMessage: peerServerMod.handleUdpMessage,
    getPeerPingInfo: peerClientMod.getPeerPingInfo,
    sendP2PMessage: peerClientMod.sendP2PMessage,
    broadcastLeave: peerClientMod.broadcastLeave,
    wireInboundToGateway: channelMod.wireInboundToGateway,
    TransportManager: transportMod.TransportManager,
    UDPTransport: transportQuicMod.UDPTransport,
    fetch: globalThis.fetch,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  }

  fs.existsSync = (targetPath) => String(targetPath).endsWith("identity.json") ? !firstRun : true
  childProcess.execSync = () => Buffer.alloc(0)

  identityMod.loadOrCreateIdentity = () => ({
    agentId: "aw:sha256:self",
    publicKey: "public-key",
    privateKey: Buffer.alloc(32).toString("base64"),
  })

  peerDbMod.initDb = () => {}
  peerDbMod.listPeers = () => [...peers.values()]
  peerDbMod.getPeer = (agentId) => peers.get(agentId) ?? null
  peerDbMod.flushDb = () => {}
  peerDbMod.getPeerIds = () => [...peers.keys()]
  peerDbMod.setTofuTtl = () => {}
  peerDbMod.findPeersByCapability = (capability) =>
    [...peers.values()].filter((peer) => peer.capabilities?.includes(capability))
  peerDbMod.upsertDiscoveredPeer = (agentId, publicKey, opts = {}) => {
    const existing = peers.get(agentId) ?? {
      agentId,
      publicKey: "",
      alias: "",
      endpoints: [],
      capabilities: [],
      source: "gossip",
    }
    peers.set(agentId, {
      ...existing,
      publicKey: existing.publicKey || publicKey,
      alias: opts.alias ?? existing.alias,
      endpoints: opts.endpoints ?? existing.endpoints,
      capabilities: opts.capabilities ?? existing.capabilities,
      source: opts.source ?? existing.source,
    })
  }
  peerDbMod.removePeer = (agentId) => {
    peers.delete(agentId)
  }

  peerServerMod.startPeerServer = async () => {}
  peerServerMod.stopPeerServer = async () => {}
  peerServerMod.setSelfMeta = () => {}
  peerServerMod.handleUdpMessage = () => {}

  peerClientMod.getPeerPingInfo = async () => pingInfo
  peerClientMod.sendP2PMessage = async (_identity, targetAddr, event, content, port, timeoutMs, opts) => {
    sendCalls.push({ targetAddr, event, content, port, timeoutMs, opts })
    if (event === "world.join") return joinResponse
    return { ok: true }
  }
  peerClientMod.broadcastLeave = async () => {}

  channelMod.wireInboundToGateway = () => {}

  transportMod.TransportManager = class MockTransportManager {
    register() {}
    async start() { return null }
    getEndpoints() { return [] }
    async stop() {}
  }

  transportQuicMod.UDPTransport = class MockUdpTransport {
    constructor() {}
    isActive() { return false }
    onMessage() {}
  }

  globalThis.fetch = async (...args) => {
    fetchCalls.push(args)
    return fetchImpl(...args)
  }

  globalThis.setTimeout = (callback) => {
    const id = nextTimerId++
    timers.set(id, callback)
    return id
  }
  globalThis.clearTimeout = (timerId) => {
    timers.delete(timerId)
  }
  globalThis.setInterval = (callback) => {
    const id = nextTimerId++
    intervals.set(id, callback)
    return id
  }
  globalThis.clearInterval = (intervalId) => {
    intervals.delete(intervalId)
  }

  const register = require("../dist/index.js").default
  let service
  const tools = new Map()
  const api = new Proxy({
    config: {
      identity: { name: "Tester" },
      plugins: { entries: { awn: { config: {
        data_dir: "/tmp/awn-test",
        advertise_address: "198.51.100.5",
        advertise_port: 8099,
      } } } },
    },
    gateway: {
      receiveChannelMessage(message) {
        gatewayMessages.push(message)
      },
    },
    registerService(definition) {
      service = definition
    },
    registerChannel() {},
    registerCli() {},
    registerTool(definition) {
      tools.set(definition.name, definition)
    },
  }, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver)
      return () => {}
    },
  })

  register(api)

  return {
    peers,
    peerServer: peerServerMod,
    sendCalls,
    gatewayMessages,
    fetchCalls,
    service,
    tools,
    async runTimers() {
      const callbacks = [...timers.values()]
      timers.clear()
      for (const callback of callbacks) {
        await callback()
      }
    },
    async runIntervals() {
      const callbacks = [...intervals.entries()]
      for (const [intervalId, callback] of callbacks) {
        if (!intervals.has(intervalId)) continue
        await callback()
      }
    },
    restore() {
      fs.existsSync = originals.existsSync
      childProcess.execSync = originals.execSync
      identityMod.loadOrCreateIdentity = originals.loadOrCreateIdentity
      peerDbMod.initDb = originals.initDb
      peerDbMod.listPeers = originals.listPeers
      peerDbMod.getPeer = originals.getPeer
      peerDbMod.flushDb = originals.flushDb
      peerDbMod.getPeerIds = originals.getPeerIds
      peerDbMod.setTofuTtl = originals.setTofuTtl
      peerDbMod.findPeersByCapability = originals.findPeersByCapability
      peerDbMod.upsertDiscoveredPeer = originals.upsertDiscoveredPeer
      peerDbMod.removePeer = originals.removePeer
      peerServerMod.startPeerServer = originals.startPeerServer
      peerServerMod.stopPeerServer = originals.stopPeerServer
      peerServerMod.setSelfMeta = originals.setSelfMeta
      peerServerMod.handleUdpMessage = originals.handleUdpMessage
      peerClientMod.getPeerPingInfo = originals.getPeerPingInfo
      peerClientMod.sendP2PMessage = originals.sendP2PMessage
      peerClientMod.broadcastLeave = originals.broadcastLeave
      channelMod.wireInboundToGateway = originals.wireInboundToGateway
      transportMod.TransportManager = originals.TransportManager
      transportQuicMod.UDPTransport = originals.UDPTransport
      globalThis.fetch = originals.fetch
      globalThis.setTimeout = originals.setTimeout
      globalThis.clearTimeout = originals.clearTimeout
      globalThis.setInterval = originals.setInterval
      globalThis.clearInterval = originals.clearInterval
      clearModuleCache()
    },
  }
}

describe("plugin lifecycle", () => {
  it("clears the first-run welcome timer on stop", async () => {
    const harness = createHarness({ firstRun: true })

    try {
      await harness.service.start()
      await harness.service.stop()
      await harness.runTimers()

      assert.equal(harness.gatewayMessages.length, 0)
    } finally {
      harness.restore()
    }
  })

  it("stores direct world joins under the world agent ID", async () => {
    const worldAgentId = "aw:sha256:world-host"
    const harness = createHarness({
      pingInfo: { ok: true, data: { agentId: worldAgentId, publicKey: "d29ybGQtcHVibGljLWtleQ==" } },
      joinResponse: {
        ok: true,
        data: {
          worldId: "arena",
          manifest: { name: "Arena" },
          members: [],
        },
      },
    })

    try {
      await harness.service.start()

      const joinWorld = harness.tools.get("join_world")
      const result = await joinWorld.execute("tool-1", { address: "203.0.113.10:9000" })

      assert.equal(result.isError, undefined)

      const joinCall = harness.sendCalls.find((call) => call.event === "world.join")
      assert.equal(joinCall?.targetAddr, "203.0.113.10")

      const worldPeer = harness.peers.get(worldAgentId)
      assert.ok(worldPeer)
      assert.deepEqual(worldPeer.endpoints, [
        { transport: "tcp", address: "203.0.113.10", port: 9000, priority: 1, ttl: 3600 },
      ])
      assert.deepEqual(worldPeer.capabilities, ["world:arena"])

      await harness.service.stop()

      const leaveCall = harness.sendCalls.find((call) => call.event === "world.leave")
      assert.equal(leaveCall?.targetAddr, "203.0.113.10")
      assert.deepEqual(leaveCall?.opts?.endpoints, worldPeer.endpoints)
    } finally {
      harness.restore()
    }
  })

  it("joins a gateway-discovered world_id after resolving missing world details", async () => {
    const worldAgentId = "aw:sha256:world-host"
    const worldPublicKey = "d29ybGQtcHVibGljLWtleQ=="
    const worldEndpoint = { transport: "tcp", address: "203.0.113.10", port: 9000, priority: 1, ttl: 3600 }
    const harness = createHarness({
      joinResponse: {
        ok: true,
        data: {
          worldId: "arena",
          manifest: { name: "Arena" },
          members: [],
        },
      },
      fetchImpl: async (url) => {
        const requestUrl = String(url)
        if (requestUrl.endsWith("/worlds")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              worlds: [{ worldId: "arena", agentId: worldAgentId, name: "Arena" }],
            }),
          }
        }
        if (requestUrl.endsWith("/world/arena")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              world: {
                agentId: worldAgentId,
                name: "Arena",
                publicKey: worldPublicKey,
                endpoints: [worldEndpoint],
              },
            }),
          }
        }
        return { ok: true, status: 200, json: async () => ({ members: [] }) }
      },
    })

    try {
      await harness.service.start()

      const listWorlds = harness.tools.get("list_worlds")
      const listed = await listWorlds.execute("tool-list", {})
      assert.equal(listed.isError, undefined)

      const joinWorld = harness.tools.get("join_world")
      const joined = await joinWorld.execute("tool-join", { world_id: "arena" })
      assert.equal(joined.isError, undefined)

      const joinCall = harness.sendCalls.find((call) => call.event === "world.join")
      assert.equal(joinCall?.targetAddr, "203.0.113.10")
      assert.ok(harness.fetchCalls.some(([requestUrl]) => String(requestUrl).endsWith("/world/arena")))

      const worldPeer = harness.peers.get(worldAgentId)
      assert.ok(worldPeer)
      assert.equal(worldPeer.publicKey, worldPublicKey)
      assert.deepEqual(worldPeer.endpoints, [worldEndpoint])
    } finally {
      harness.restore()
    }
  })

  it("drops scoped members when world membership refresh is rejected", async () => {
    const worldAgentId = "aw:sha256:world-host"
    let refreshCalls = 0
    const harness = createHarness({
      pingInfo: { ok: true, data: { agentId: worldAgentId, publicKey: "d29ybGQtcHVibGljLWtleQ==" } },
      joinResponse: {
        ok: true,
        data: {
          worldId: "arena",
          manifest: { name: "Arena" },
          members: [
            {
              agentId: "aw:sha256:member-1",
              alias: "Member One",
              endpoints: [
                { transport: "tcp", address: "198.51.100.20", port: 9100, priority: 1, ttl: 3600 },
              ],
            },
          ],
        },
      },
      fetchImpl: async () => {
        refreshCalls += 1
        return {
          ok: false,
          status: 403,
          json: async () => ({ members: [] }),
        }
      },
    })

    try {
      await harness.service.start()

      const joinWorld = harness.tools.get("join_world")
      const result = await joinWorld.execute("tool-2", { address: "203.0.113.10:9000" })

      assert.equal(result.isError, undefined)
      assert.ok(harness.peers.get("aw:sha256:member-1"))

      await harness.runIntervals()
      assert.equal(refreshCalls, 1)
      assert.equal(harness.peers.get("aw:sha256:member-1"), undefined)
      assert.ok(harness.peers.get(worldAgentId))

      await harness.runIntervals()
      assert.equal(refreshCalls, 1)
    } finally {
      harness.restore()
    }
  })

  it("revokes the peer-server allowlist when repeated refresh failures drop a world", async () => {
    const worldAgentId = "aw:sha256:world-host"
    let refreshCalls = 0
    const harness = createHarness({
      pingInfo: { ok: true, data: { agentId: worldAgentId, publicKey: "d29ybGQtcHVibGljLWtleQ==" } },
      joinResponse: {
        ok: true,
        data: {
          worldId: "arena",
          manifest: { name: "Arena" },
          members: [
            {
              agentId: "aw:sha256:member-1",
              alias: "Member One",
              endpoints: [
                { transport: "tcp", address: "198.51.100.20", port: 9100, priority: 1, ttl: 3600 },
              ],
            },
          ],
        },
      },
      fetchImpl: async () => {
        refreshCalls += 1
        return {
          ok: false,
          status: 500,
          json: async () => ({ members: [] }),
        }
      },
    })

    try {
      await harness.service.start()

      const joinWorld = harness.tools.get("join_world")
      const result = await joinWorld.execute("tool-3", { address: "203.0.113.10:9000" })

      assert.equal(result.isError, undefined)
      assert.equal(harness.peerServer.isCoMember("aw:sha256:member-1"), true)

      await harness.runIntervals()
      await harness.runIntervals()
      assert.equal(refreshCalls, 2)
      assert.equal(harness.peerServer.isCoMember("aw:sha256:member-1"), true)

      await harness.runIntervals()
      assert.equal(refreshCalls, 3)
      assert.equal(harness.peerServer.isCoMember("aw:sha256:member-1"), false)
    } finally {
      harness.restore()
    }
  })
})

// Base64 of "world-public-key" — test-only fixture, not a real secret
const MOCK_WORLD_PUB = "d29ybGQtcHVibGljLWtleQ=="

describe("world_action tool", () => {
  it("sends a world.action message with correct payload", async () => {
    const worldAgentId = "aw:sha256:world-host"
    const harness = createHarness({
      pingInfo: { ok: true, data: { agentId: worldAgentId, publicKey: MOCK_WORLD_PUB } },
      joinResponse: {
        ok: true,
        data: {
          worldId: "arena",
          manifest: { name: "Arena", actions: { say: { desc: "Say something" } } },
          members: [],
        },
      },
    })

    try {
      await harness.service.start()

      const joinWorld = harness.tools.get("join_world")
      await joinWorld.execute("t-1", { address: "203.0.113.10:9000" })

      const worldAction = harness.tools.get("world_action")
      const result = await worldAction.execute("t-2", { action: "say", action_params: { text: "hello" } })

      assert.equal(result.isError, undefined)
      assert.ok(result.content[0].text.includes("say"))

      const actionCall = harness.sendCalls.find((call) => call.event === "world.action")
      assert.ok(actionCall)
      const payload = JSON.parse(actionCall.content)
      assert.equal(payload.action, "say")
      assert.equal(payload.text, "hello")
      assert.equal(actionCall.targetAddr, "203.0.113.10")
      assert.equal(actionCall.port, 9000)
    } finally {
      harness.restore()
    }
  })

  it("auto-selects the only joined world when world_id is omitted", async () => {
    const worldAgentId = "aw:sha256:world-host"
    const harness = createHarness({
      pingInfo: { ok: true, data: { agentId: worldAgentId, publicKey: MOCK_WORLD_PUB } },
      joinResponse: {
        ok: true,
        data: {
          worldId: "arena",
          manifest: { name: "Arena" },
          members: [],
        },
      },
    })

    try {
      await harness.service.start()

      const joinWorld = harness.tools.get("join_world")
      await joinWorld.execute("t-1", { address: "203.0.113.10:9000" })

      const worldAction = harness.tools.get("world_action")
      const result = await worldAction.execute("t-2", { action: "move" })

      assert.equal(result.isError, undefined)
      assert.ok(result.content[0].text.includes("arena"))
    } finally {
      harness.restore()
    }
  })

  it("rejects when no worlds are joined", async () => {
    const harness = createHarness()

    try {
      await harness.service.start()

      const worldAction = harness.tools.get("world_action")
      const result = await worldAction.execute("t-1", { action: "say" })

      assert.equal(result.isError, true)
      assert.ok(result.content[0].text.includes("Not joined"))
    } finally {
      harness.restore()
    }
  })

  it("rejects ambiguous world_id when multiple worlds are joined", async () => {
    const worldAgentId = "aw:sha256:world-host"
    let joinCount = 0
    const harness = createHarness({
      pingInfo: { ok: true, data: { agentId: worldAgentId, publicKey: MOCK_WORLD_PUB } },
      joinResponse: {
        ok: true,
        data: {
          worldId: "arena",
          manifest: { name: "Arena" },
          members: [],
        },
      },
    })

    // Override sendP2PMessage to return different worldIds
    const peerClientMod = createRequire(import.meta.url)("../dist/peer-client.js")
    const origSend = peerClientMod.sendP2PMessage
    peerClientMod.sendP2PMessage = async (_identity, targetAddr, event, content, port, timeoutMs, opts) => {
      harness.sendCalls.push({ targetAddr, event, content, port, timeoutMs, opts })
      if (event === "world.join") {
        joinCount++
        return {
          ok: true,
          data: {
            worldId: joinCount === 1 ? "arena" : "lobby",
            manifest: { name: joinCount === 1 ? "Arena" : "Lobby" },
            members: [],
          },
        }
      }
      return { ok: true }
    }

    try {
      await harness.service.start()

      const joinWorld = harness.tools.get("join_world")
      await joinWorld.execute("t-1", { address: "203.0.113.10:9000" })
      await joinWorld.execute("t-2", { address: "203.0.113.10:9001" })

      const worldAction = harness.tools.get("world_action")
      const result = await worldAction.execute("t-3", { action: "say" })

      assert.equal(result.isError, true)
      assert.ok(result.content[0].text.includes("Multiple worlds"))
      assert.ok(result.content[0].text.includes("Specify world_id"))
    } finally {
      peerClientMod.sendP2PMessage = origSend
      harness.restore()
    }
  })

  it("awn_status includes action signatures with param schemas", async () => {
    const worldAgentId = "aw:sha256:world-host"
    const harness = createHarness({
      pingInfo: { ok: true, data: { agentId: worldAgentId, publicKey: MOCK_WORLD_PUB } },
      joinResponse: {
        ok: true,
        data: {
          worldId: "arena",
          manifest: {
            name: "Arena",
            actions: {
              say: { desc: "Say something", params: { text: { type: "string", required: true } } },
              set_state: {
                desc: "Update your state",
                params: {
                  state: { type: "string", enum: ["idle", "writing", "error"] },
                  detail: { type: "string", required: false, max: 200 },
                },
              },
            },
          },
          members: [],
        },
      },
    })

    try {
      await harness.service.start()

      const joinWorld = harness.tools.get("join_world")
      await joinWorld.execute("t-1", { address: "203.0.113.10:9000" })

      const awnStatus = harness.tools.get("awn_status")
      const result = await awnStatus.execute("t-2", {})

      const text = result.content[0].text
      assert.ok(text.includes("arena"))
      assert.ok(text.includes("Arena"))
      assert.ok(text.includes("say(text: string)"))
      assert.ok(text.includes("Say something"))
      assert.ok(text.includes('"idle"|"writing"|"error"'))
      assert.ok(text.includes("detail?:"))
      assert.ok(text.includes("[max 200]"))
    } finally {
      harness.restore()
    }
  })
})

describe("join_world action signatures", () => {
  it("join_world response includes formatted action signatures", async () => {
    const worldAgentId = "aw:sha256:world-host"
    const harness = createHarness({
      pingInfo: { ok: true, data: { agentId: worldAgentId, publicKey: MOCK_WORLD_PUB } },
      joinResponse: {
        ok: true,
        data: {
          worldId: "office",
          manifest: {
            name: "Star Office",
            actions: {
              set_state: {
                desc: "Update agent's work status",
                params: {
                  state: { type: "string", enum: ["idle", "writing", "researching"] },
                  detail: { type: "string", required: false, max: 200 },
                },
              },
              heartbeat: { desc: "Keep-alive signal" },
              post_memo: {
                desc: "Post a work memo",
                params: { content: { type: "string", max: 2000 } },
              },
            },
          },
          members: [],
        },
      },
    })

    try {
      await harness.service.start()

      const joinWorld = harness.tools.get("join_world")
      const result = await joinWorld.execute("t-1", { address: "203.0.113.10:9000" })

      const text = result.content[0].text
      assert.ok(text.includes("Joined world 'office' (Star Office)"))
      assert.ok(text.includes("Available actions:"))
      assert.ok(text.includes('"idle"|"writing"|"researching"'))
      assert.ok(text.includes("detail?:"))
      assert.ok(text.includes("heartbeat()"))
      assert.ok(text.includes("[max 2000]"))
    } finally {
      harness.restore()
    }
  })

  it("join_world omits actions section when manifest has no actions", async () => {
    const worldAgentId = "aw:sha256:world-host"
    const harness = createHarness({
      pingInfo: { ok: true, data: { agentId: worldAgentId, publicKey: MOCK_WORLD_PUB } },
      joinResponse: {
        ok: true,
        data: {
          worldId: "arena",
          manifest: { name: "Arena" },
          members: [],
        },
      },
    })

    try {
      await harness.service.start()

      const joinWorld = harness.tools.get("join_world")
      const result = await joinWorld.execute("t-1", { address: "203.0.113.10:9000" })

      const text = result.content[0].text
      assert.ok(text.includes("Joined world 'arena' (Arena)"))
      assert.equal(text.includes("Available actions:"), false)
    } finally {
      harness.restore()
    }
  })
})

describe("world_info tool", () => {
  it("returns full manifest with action param schemas", async () => {
    const worldAgentId = "aw:sha256:world-host"
    const harness = createHarness({
      pingInfo: { ok: true, data: { agentId: worldAgentId, publicKey: MOCK_WORLD_PUB } },
      joinResponse: {
        ok: true,
        data: {
          worldId: "office",
          manifest: {
            name: "Star Office",
            description: "A collaborative workspace",
            objective: "Work together",
            actions: {
              set_state: {
                desc: "Update status",
                params: {
                  state: { type: "string", enum: ["idle", "writing"] },
                },
              },
            },
            rules: [
              { text: "Be respectful", enforced: true },
              { text: "Have fun", enforced: false },
            ],
            lifecycle: { evictionPolicy: "idle", idleTimeoutMs: 300000 },
          },
          members: [],
        },
      },
    })

    try {
      await harness.service.start()

      const joinWorld = harness.tools.get("join_world")
      await joinWorld.execute("t-1", { address: "203.0.113.10:9000" })

      const worldInfo = harness.tools.get("world_info")
      const result = await worldInfo.execute("t-2", {})

      const text = result.content[0].text
      assert.ok(text.includes("World: Star Office (office)"))
      assert.ok(text.includes("Description: A collaborative workspace"))
      assert.ok(text.includes("Objective: Work together"))
      assert.ok(text.includes("Actions:"))
      assert.ok(text.includes('"idle"|"writing"'))
      assert.ok(text.includes("[enforced] Be respectful"))
      assert.ok(text.includes("[advisory] Have fun"))
      assert.ok(text.includes("Lifecycle:"))
      assert.ok(text.includes("evictionPolicy: idle"))
    } finally {
      harness.restore()
    }
  })

  it("auto-selects single joined world", async () => {
    const worldAgentId = "aw:sha256:world-host"
    const harness = createHarness({
      pingInfo: { ok: true, data: { agentId: worldAgentId, publicKey: MOCK_WORLD_PUB } },
      joinResponse: {
        ok: true,
        data: { worldId: "arena", manifest: { name: "Arena" }, members: [] },
      },
    })

    try {
      await harness.service.start()

      const joinWorld = harness.tools.get("join_world")
      await joinWorld.execute("t-1", { address: "203.0.113.10:9000" })

      const worldInfo = harness.tools.get("world_info")
      const result = await worldInfo.execute("t-2", {})

      assert.equal(result.isError, undefined)
      assert.ok(result.content[0].text.includes("World: Arena (arena)"))
    } finally {
      harness.restore()
    }
  })

  it("rejects when no worlds are joined", async () => {
    const harness = createHarness()

    try {
      await harness.service.start()

      const worldInfo = harness.tools.get("world_info")
      const result = await worldInfo.execute("t-1", {})

      assert.equal(result.isError, true)
      assert.ok(result.content[0].text.includes("Not joined"))
    } finally {
      harness.restore()
    }
  })

  it("rejects unknown world_id", async () => {
    const worldAgentId = "aw:sha256:world-host"
    const harness = createHarness({
      pingInfo: { ok: true, data: { agentId: worldAgentId, publicKey: MOCK_WORLD_PUB } },
      joinResponse: {
        ok: true,
        data: { worldId: "arena", manifest: { name: "Arena" }, members: [] },
      },
    })

    try {
      await harness.service.start()

      const joinWorld = harness.tools.get("join_world")
      await joinWorld.execute("t-1", { address: "203.0.113.10:9000" })

      const worldInfo = harness.tools.get("world_info")
      const result = await worldInfo.execute("t-2", { world_id: "nonexistent" })

      assert.equal(result.isError, true)
      assert.ok(result.content[0].text.includes("Not joined world 'nonexistent'"))
    } finally {
      harness.restore()
    }
  })
})
