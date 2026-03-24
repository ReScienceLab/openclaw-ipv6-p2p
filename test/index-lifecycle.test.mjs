import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

const MODULE_IDS = [
  "../dist/index.js",
  "../dist/identity.js",
  "../dist/agent-db.js",
  "../dist/world-db.js",
  "../dist/agent-server.js",
  "../dist/agent-client.js",
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
  const agentDbMod = require("../dist/agent-db.js")
  const worldDbMod = require("../dist/world-db.js")
  const agentServerMod = require("../dist/agent-server.js")
  const agentClientMod = require("../dist/agent-client.js")
  const channelMod = require("../dist/channel.js")
  const transportMod = require("../dist/transport.js")
  const transportQuicMod = require("../dist/transport-quic.js")

  const agents = new Map()
  const worlds = new Map()
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
    initDb: agentDbMod.initDb,
    listAgents: agentDbMod.listAgents,
    getAgent: agentDbMod.getAgent,
    flushDb: agentDbMod.flushDb,
    getAgentIds: agentDbMod.getAgentIds,
    setTofuTtl: agentDbMod.setTofuTtl,
    findAgentsByCapability: agentDbMod.findAgentsByCapability,
    upsertDiscoveredAgent: agentDbMod.upsertDiscoveredAgent,
    removeAgent: agentDbMod.removeAgent,
    initWorldDb: worldDbMod.initWorldDb,
    listWorlds: worldDbMod.listWorlds,
    getWorld: worldDbMod.getWorld,
    getWorldBySlug: worldDbMod.getWorldBySlug,
    upsertWorld: worldDbMod.upsertWorld,
    flushWorldDb: worldDbMod.flushWorldDb,
    startAgentServer: agentServerMod.startAgentServer,
    stopAgentServer: agentServerMod.stopAgentServer,
    setSelfMeta: agentServerMod.setSelfMeta,
    handleUdpMessage: agentServerMod.handleUdpMessage,
    getAgentPingInfo: agentClientMod.getAgentPingInfo,
    sendP2PMessage: agentClientMod.sendP2PMessage,
    broadcastLeave: agentClientMod.broadcastLeave,
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

  agentDbMod.initDb = () => {}
  agentDbMod.listAgents = () => [...agents.values()]
  agentDbMod.getAgent = (agentId) => agents.get(agentId) ?? null
  agentDbMod.flushDb = () => {}
  agentDbMod.getAgentIds = () => [...agents.keys()]
  agentDbMod.setTofuTtl = () => {}
  agentDbMod.findAgentsByCapability = (capability) =>
    [...agents.values()].filter((agent) => agent.capabilities?.includes(capability))
  agentDbMod.upsertDiscoveredAgent = (agentId, publicKey, opts = {}) => {
    const existing = agents.get(agentId) ?? {
      agentId,
      publicKey: "",
      alias: "",
      endpoints: [],
      capabilities: [],
      source: "gossip",
    }
    agents.set(agentId, {
      ...existing,
      publicKey: existing.publicKey || publicKey,
      alias: opts.alias ?? existing.alias,
      endpoints: opts.endpoints ?? existing.endpoints,
      capabilities: opts.capabilities ?? existing.capabilities,
      source: opts.source ?? existing.source,
    })
  }
  agentDbMod.removeAgent = (agentId) => {
    agents.delete(agentId)
  }

  worldDbMod.initWorldDb = () => {}
  worldDbMod.listWorlds = () => [...worlds.values()]
  worldDbMod.getWorld = (worldId) => worlds.get(worldId) ?? null
  worldDbMod.getWorldBySlug = (slug) =>
    [...worlds.values()].find((world) => world.slug === slug) ?? null
  worldDbMod.upsertWorld = (worldId, opts = {}) => {
    const existing = worlds.get(worldId) ?? {
      worldId,
      slug: worldId,
      publicKey: "",
      endpoints: [],
      lastSeen: 0,
      source: "gossip",
    }
    worlds.set(worldId, {
      ...existing,
      ...opts,
      worldId,
      slug: opts.slug ?? existing.slug,
      publicKey: opts.publicKey ?? existing.publicKey,
      endpoints: opts.endpoints ?? existing.endpoints,
      lastSeen: opts.lastSeen ?? Date.now(),
      source: opts.source ?? existing.source,
    })
  }
  worldDbMod.flushWorldDb = () => {}

  agentServerMod.startAgentServer = async () => {}
  agentServerMod.stopAgentServer = async () => {}
  agentServerMod.setSelfMeta = () => {}
  agentServerMod.handleUdpMessage = () => {}

  agentClientMod.getAgentPingInfo = async () => pingInfo
  agentClientMod.sendP2PMessage = async (_identity, targetAddr, event, content, port, timeoutMs, opts) => {
    sendCalls.push({ targetAddr, event, content, port, timeoutMs, opts })
    if (event === "world.join") return joinResponse
    return { ok: true }
  }
  agentClientMod.broadcastLeave = async () => {}

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
    agents,
    worlds,
    agentServer: agentServerMod,
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
      agentDbMod.initDb = originals.initDb
      agentDbMod.listAgents = originals.listAgents
      agentDbMod.getAgent = originals.getAgent
      agentDbMod.flushDb = originals.flushDb
      agentDbMod.getAgentIds = originals.getAgentIds
      agentDbMod.setTofuTtl = originals.setTofuTtl
      agentDbMod.findAgentsByCapability = originals.findAgentsByCapability
      agentDbMod.upsertDiscoveredAgent = originals.upsertDiscoveredAgent
      agentDbMod.removeAgent = originals.removeAgent
      worldDbMod.initWorldDb = originals.initWorldDb
      worldDbMod.listWorlds = originals.listWorlds
      worldDbMod.getWorld = originals.getWorld
      worldDbMod.getWorldBySlug = originals.getWorldBySlug
      worldDbMod.upsertWorld = originals.upsertWorld
      worldDbMod.flushWorldDb = originals.flushWorldDb
      agentServerMod.startAgentServer = originals.startAgentServer
      agentServerMod.stopAgentServer = originals.stopAgentServer
      agentServerMod.setSelfMeta = originals.setSelfMeta
      agentServerMod.handleUdpMessage = originals.handleUdpMessage
      agentClientMod.getAgentPingInfo = originals.getAgentPingInfo
      agentClientMod.sendP2PMessage = originals.sendP2PMessage
      agentClientMod.broadcastLeave = originals.broadcastLeave
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
})
