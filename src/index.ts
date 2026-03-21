/**
 * AWN — Agent World Network — OpenClaw plugin entry point.
 *
 * Agent ID (sha256(publicKey)[:16]) is the primary peer identifier.
 * Transport is plain HTTP over TCP; QUIC is available as a fast optional transport.
 */
import * as os from "os"
import * as path from "path"
import { execSync } from "child_process"
import { loadOrCreateIdentity, deriveDidKey, verifyHttpResponseHeaders } from "./identity"
import { initDb, listPeers, getPeer, flushDb, getPeerIds, getEndpointAddress, setTofuTtl, findPeersByCapability, removePeer } from "./peer-db"
import { startPeerServer, stopPeerServer, setSelfMeta, handleUdpMessage, addWorldMembers, setWorldMembers, removeWorld, clearWorldMembers } from "./peer-server"
import { sendP2PMessage, pingPeer, broadcastLeave, SendOptions, getPeerPingInfo } from "./peer-client"
import { upsertDiscoveredPeer } from "./peer-db"
import { buildChannel, wireInboundToGateway, CHANNEL_CONFIG_SCHEMA } from "./channel"
import { Identity, PluginConfig, Endpoint } from "./types"
import { TransportManager } from "./transport"
import { UDPTransport } from "./transport-quic"
import { parseDirectPeerAddress } from "./address"

const AWN_TOOLS = [
  "p2p_list_peers",
  "p2p_send_message", "p2p_status",
  "list_worlds", "join_world",
]

function ensureToolsAllowed(config: any): void {
  try {
    const alsoAllow: string[] = config?.tools?.alsoAllow ?? []
    const missing = AWN_TOOLS.filter(t => !alsoAllow.includes(t))
    if (missing.length === 0) return
    const merged = [...alsoAllow, ...missing]
    const jsonVal = JSON.stringify(merged)
    execSync(`openclaw config set tools.alsoAllow '${jsonVal}'`, { timeout: 5000, stdio: "ignore" })
    console.log(`[awn] Auto-enabled ${missing.length} AWN tool(s) in tools.alsoAllow`)
  } catch {
    console.warn("[awn] Could not auto-enable tools — enable manually via: openclaw config set tools.alsoAllow")
  }
}

function ensurePluginAllowed(config: any): void {
  try {
    const allow: string[] | undefined = config?.plugins?.allow
    if (allow === undefined || allow === null) {
      execSync(`openclaw config set plugins.allow '["awn"]'`, { timeout: 5000, stdio: "ignore" })
      console.log("[awn] Set plugins.allow to [awn]")
      return
    }
    if (Array.isArray(allow) && !allow.includes("awn")) {
      const merged = [...allow, "awn"]
      execSync(`openclaw config set plugins.allow '${JSON.stringify(merged)}'`, { timeout: 5000, stdio: "ignore" })
      console.log("[awn] Added awn to plugins.allow")
    }
  } catch { /* best effort */ }
}

function ensureChannelConfig(config: any): void {
  try {
    const channelCfg = config?.channels?.awn
    if (channelCfg && channelCfg.dmPolicy) return
    execSync(`openclaw config set channels.awn.dmPolicy '"pairing"'`, { timeout: 5000, stdio: "ignore" })
    console.log("[awn] Set channels.awn.dmPolicy to pairing")
  } catch { /* best effort */ }
}

let identity: Identity | null = null
let dataDir: string = path.join(os.homedir(), ".openclaw", "awn")
let peerPort: number = 8099
let _agentMeta: { name?: string; version?: string; endpoints?: Endpoint[] } = {}
let _transportManager: TransportManager | null = null
let _quicTransport: UDPTransport | null = null

// Track joined worlds for periodic member refresh
const _joinedWorlds = new Map<string, { agentId: string; address: string; port: number; publicKey: string }>()
const _worldMembersByWorld = new Map<string, Set<string>>()
const _worldScopedPeerWorlds = new Map<string, Set<string>>()
const _worldRefreshFailures = new Map<string, number>()
let _memberRefreshTimer: ReturnType<typeof setInterval> | null = null
let _welcomeTimer: ReturnType<typeof setTimeout> | null = null
const MEMBER_REFRESH_INTERVAL_MS = 30_000
const WORLD_MEMBER_REFRESH_FAILURE_LIMIT = 3

function trackWorldScopedPeer(agentId: string, worldId: string): void {
  let worldIds = _worldScopedPeerWorlds.get(agentId)
  if (!worldIds) {
    worldIds = new Set<string>()
    _worldScopedPeerWorlds.set(agentId, worldIds)
  }
  worldIds.add(worldId)
}

function untrackWorldScopedPeer(agentId: string, worldId: string): void {
  const worldIds = _worldScopedPeerWorlds.get(agentId)
  if (!worldIds) return

  worldIds.delete(worldId)
  if (worldIds.size > 0) return

  _worldScopedPeerWorlds.delete(agentId)
  if (getPeer(agentId)?.source !== "manual") {
    removePeer(agentId)
  }
}

function syncWorldMembers(
  worldId: string,
  members: Array<{ agentId: string; alias?: string; endpoints?: Endpoint[] }>
): void {
  const nextMemberIds = new Set<string>()
  const previousMemberIds = _worldMembersByWorld.get(worldId) ?? new Set<string>()

  for (const member of members) {
    if (!member.agentId || member.agentId === identity?.agentId) continue

    nextMemberIds.add(member.agentId)

    const existingPeer = getPeer(member.agentId)
    if (!existingPeer || existingPeer.source !== "manual") {
      upsertDiscoveredPeer(member.agentId, "", {
        alias: member.alias,
        endpoints: member.endpoints,
        source: "gossip",
      })
    }

    trackWorldScopedPeer(member.agentId, worldId)
  }

  for (const agentId of previousMemberIds) {
    if (!nextMemberIds.has(agentId)) {
      untrackWorldScopedPeer(agentId, worldId)
    }
  }

  _worldMembersByWorld.set(worldId, nextMemberIds)
}

function removeWorldMembers(worldId: string): void {
  const memberIds = _worldMembersByWorld.get(worldId)
  if (!memberIds) return

  for (const agentId of memberIds) {
    untrackWorldScopedPeer(agentId, worldId)
  }

  _worldMembersByWorld.delete(worldId)
}

function stopWorldMemberRefreshIfIdle(): void {
  if (_joinedWorlds.size > 0 || !_memberRefreshTimer) return

  clearInterval(_memberRefreshTimer)
  _memberRefreshTimer = null
}

function dropJoinedWorld(worldId: string): void {
  removeWorldMembers(worldId)
  removeWorld(worldId)
  _joinedWorlds.delete(worldId)
  _worldRefreshFailures.delete(worldId)
  stopWorldMemberRefreshIfIdle()
}

function recordWorldRefreshFailure(worldId: string): void {
  const failures = (_worldRefreshFailures.get(worldId) ?? 0) + 1
  if (failures >= WORLD_MEMBER_REFRESH_FAILURE_LIMIT) {
    dropJoinedWorld(worldId)
    return
  }

  _worldRefreshFailures.set(worldId, failures)
}

async function refreshWorldMembers(): Promise<void> {
  if (!identity) return
  for (const [worldId, info] of _joinedWorlds) {
    try {
      const { signHttpRequest } = require("./identity")
      const isIpv6 = info.address.includes(":") && !info.address.includes(".")
      const host = isIpv6 ? `[${info.address}]:${info.port}` : `${info.address}:${info.port}`
      const url = `http://${host}/world/members`
      const awHeaders = signHttpRequest(identity!, "GET", host, "/world/members", "")
      const resp = await fetch(url, {
        headers: { ...awHeaders },
        signal: AbortSignal.timeout(10_000),
      })
      if (resp.status === 403 || resp.status === 404) {
        dropJoinedWorld(worldId)
        removeWorld(worldId)
        continue
      }
      if (!resp.ok) {
        recordWorldRefreshFailure(worldId)
        continue
      }
      const bodyText = await resp.text()
      const verification = verifyHttpResponseHeaders(
        Object.fromEntries(Array.from(resp.headers.entries()).map(([key, value]) => [key, value])),
        resp.status,
        bodyText,
        info.publicKey
      )
      if (!verification.ok) {
        recordWorldRefreshFailure(worldId)
        continue
      }

      const body = JSON.parse(bodyText) as { members?: Array<{ agentId: string; alias?: string; endpoints?: Endpoint[] }> }
      const memberList = body.members ?? []
      syncWorldMembers(worldId, memberList)
      setWorldMembers(
        worldId,
        [info.agentId, ...memberList.map(m => m.agentId).filter(id => id !== identity!.agentId)]
      )
      _worldRefreshFailures.delete(worldId)
    } catch {
      recordWorldRefreshFailure(worldId)
    }
  }
}

async function leaveJoinedWorlds(): Promise<void> {
  if (!identity || _joinedWorlds.size === 0) return

  await Promise.allSettled(
    [..._joinedWorlds.values()].map((info) =>
      sendP2PMessage(
        identity!,
        info.address,
        "world.leave",
        "",
        info.port,
        3_000,
        buildSendOpts(info.agentId)
      )
    )
  )
}

function buildSendOpts(peerIdOrAddr?: string): SendOptions {
  const peer = peerIdOrAddr ? getPeer(peerIdOrAddr) : null
  return {
    endpoints: peer?.endpoints,
    quicTransport: _quicTransport?.isActive() ? _quicTransport : undefined,
    expectedPublicKey: peer?.publicKey || undefined,
  }
}

function getGatewayUrl(): string {
  return (process.env.GATEWAY_URL ?? "http://localhost:8100").replace(/\/+$/, "")
}

async function fetchGatewayWorldRecord(worldId: string): Promise<{
  agentId?: string
  alias?: string
  endpoints?: Endpoint[]
  publicKey?: string
} | null> {
  try {
    const resp = await fetch(`${getGatewayUrl()}/world/${encodeURIComponent(worldId)}`, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!resp.ok) return null

    const data = await resp.json() as Record<string, unknown>
    const detail = typeof data.world === "object" && data.world
      ? data.world as Record<string, unknown>
      : data
    const host = typeof detail.host === "object" && detail.host
      ? detail.host as Record<string, unknown>
      : null

    const endpoints = Array.isArray(detail.endpoints)
      ? detail.endpoints as Endpoint[]
      : Array.isArray(host?.endpoints)
        ? host.endpoints as Endpoint[]
        : undefined
    const publicKey = typeof detail.publicKey === "string"
      ? detail.publicKey
      : typeof host?.publicKey === "string"
        ? host.publicKey
        : undefined
    const agentId = typeof detail.agentId === "string"
      ? detail.agentId
      : typeof host?.agentId === "string"
        ? host.agentId
        : undefined
    const alias = typeof detail.name === "string"
      ? detail.name
      : typeof detail.alias === "string"
        ? detail.alias
        : typeof host?.name === "string"
          ? host.name
          : typeof host?.alias === "string"
            ? host.alias
            : undefined

    return { agentId, alias, endpoints, publicKey }
  } catch {
    return null
  }
}

export default function register(api: any) {
  api.registerService({
    id: "awn-node",

    start: async () => {
      ensurePluginAllowed(api.config)
      ensureToolsAllowed(api.config)
      ensureChannelConfig(api.config)

      const cfg: PluginConfig = api.config?.plugins?.entries?.["awn"]?.config ?? {}
      dataDir = cfg.data_dir ?? dataDir
      peerPort = cfg.peer_port ?? peerPort
      const pluginVersion: string = require("../package.json").version
      _agentMeta = { name: cfg.agent_name ?? api.config?.identity?.name, version: pluginVersion }

      const isFirstRun = !require("fs").existsSync(path.join(dataDir, "identity.json"))
      identity = loadOrCreateIdentity(dataDir)
      initDb(dataDir)
      if (cfg.tofu_ttl_days !== undefined) setTofuTtl(cfg.tofu_ttl_days)

      console.log(`[awn] Agent ID:  ${identity.agentId}`)
      if (_agentMeta.name) {
        console.log(`[awn] Name:      ${_agentMeta.name}`)
      }

      _transportManager = new TransportManager()
      _quicTransport = new UDPTransport()
      _transportManager.register(_quicTransport)

      const quicPort = cfg.quic_port ?? 8098
      const activeTransport = await _transportManager.start(identity, {
        dataDir,
        quicPort,
        advertiseAddress: cfg.advertise_address,
        advertisePort: cfg.advertise_port,
      })

      if (activeTransport) {
        console.log(`[awn] Active transport: ${activeTransport.id} -> ${activeTransport.address}`)

        if (_quicTransport.isActive()) {
          console.log(`[awn] QUIC endpoint: ${_quicTransport.address}`)
          _quicTransport.onMessage((from, data) => {
            handleUdpMessage(data, from)
          })
        }
      } else {
        console.warn("[awn] No QUIC transport available — HTTP-only mode")
      }

      const advertisedEndpoints = _transportManager.getEndpoints()
      if (cfg.advertise_address) {
        advertisedEndpoints.push({
          transport: "tcp",
          address: cfg.advertise_address,
          port: peerPort,
          priority: advertisedEndpoints.length ? 2 : 1,
          ttl: 3600,
        })
      }
      _agentMeta.endpoints = advertisedEndpoints

      await startPeerServer(peerPort, { identity })

      setSelfMeta({
        agentId: identity.agentId,
        publicKey: identity.publicKey,
        ..._agentMeta,
      })

      wireInboundToGateway(api)

      if (isFirstRun) {
        const welcomeLines = [
          "Welcome to Agent World Network!",
          "",
          `Your Agent ID: ${identity.agentId}`,
          _quicTransport?.isActive()
            ? `QUIC transport active: ${_quicTransport.address}`
            : "Running in HTTP-only mode.",
          "",
          "Quick start:",
          "  openclaw awn status     — show your agent ID",
          "  openclaw join_world <id> — join a world to discover peers",
        ]
        _welcomeTimer = setTimeout(() => {
          _welcomeTimer = null
          try {
            api.gateway?.receiveChannelMessage?.({
              channelId: "awn",
              accountId: "system",
              text: welcomeLines.join("\n"),
              senderId: "awn-system",
            })
          } catch { /* best effort */ }
        }, 2000)
      }

      console.log(`[awn] Ready — join a world to discover peers`)
    },

    stop: async () => {
      if (_memberRefreshTimer) {
        clearInterval(_memberRefreshTimer)
        _memberRefreshTimer = null
      }
      if (_welcomeTimer) {
        clearTimeout(_welcomeTimer)
        _welcomeTimer = null
      }
      await leaveJoinedWorlds()
      for (const worldId of _joinedWorlds.keys()) {
        removeWorldMembers(worldId)
      }
      _joinedWorlds.clear()
      clearWorldMembers()
      _worldRefreshFailures.clear()
      if (identity) {
        await broadcastLeave(identity, listPeers(), peerPort, buildSendOpts())
      }
      flushDb()
      await stopPeerServer()
      if (_transportManager) {
        await _transportManager.stop()
        _transportManager = null
      }
    },
  })

  // ── Channel ────────────────────────────────────────────────────────────────
  if (identity) {
    api.registerChannel({ plugin: buildChannel(identity, peerPort, buildSendOpts) })
  } else {
    api.registerChannel({
      plugin: {
        id: "awn",
        meta: {
          id: "awn",
          label: "AWN",
          selectionLabel: "AWN (Agent World Network)",
          docsPath: "/channels/awn",
          blurb: "Agent World Network — world-scoped agent communication.",
          aliases: ["p2p"],
        },
        capabilities: { chatTypes: ["direct"] },
        configSchema: CHANNEL_CONFIG_SCHEMA,
        config: {
          listAccountIds: () => (identity ? getPeerIds() : []),
          resolveAccount: (_: unknown, accountId: string | undefined) => {
            const peer = accountId ? getPeer(accountId) : null
            return {
              accountId: accountId ?? "",
              agentId: peer?.agentId ?? accountId ?? "",
            }
          },
        },
        outbound: {
          deliveryMode: "direct" as const,
          sendText: async ({ text, account }: { text: string; account: { agentId?: string } }) => {
            if (!identity) return { ok: false }
            const agentId = account.agentId ?? ""
            const r = await sendP2PMessage(identity, agentId, "chat", text, peerPort, 10_000, buildSendOpts(agentId))
            return { ok: r.ok }
          },
        },
      },
    })
  }

  // ── CLI commands ───────────────────────────────────────────────────────────
  api.registerCli(
    ({ program }: { program: any }) => {
      const awn = program.command("awn").description("Agent World Network node management")

      awn
        .command("status")
        .description("Show this node's agent ID and status")
        .action(() => {
          if (!identity) {
            console.log("Plugin not started yet. Try again after gateway restart.")
            return
          }
          console.log("=== AWN Node Status ===")
          if (_agentMeta.name) console.log(`Agent name:     ${_agentMeta.name}`)
          console.log(`Agent ID:       ${identity.agentId}`)
          console.log(`DID Key:        ${deriveDidKey(identity.publicKey)}`)
          console.log(`Version:        v${_agentMeta.version}`)
          console.log(`Transport:      ${_transportManager?.active?.id ?? "http-only"}`)
          if (_quicTransport?.isActive()) {
            console.log(`QUIC endpoint:  ${_quicTransport.address}`)
          }
          console.log(`Peer port:      ${peerPort}`)
          console.log(`Known peers:    ${listPeers().length}`)
          console.log(`Worlds joined:  ${_joinedWorlds.size}`)
        })

      awn
        .command("peers")
        .description("List known peers")
        .action(() => {
          const peers = listPeers()
          if (peers.length === 0) {
            console.log("No peers yet. Use 'openclaw awn add <agent-id>' to add one.")
            return
          }
          console.log("=== Known Peers ===")
          for (const peer of peers) {
            const ago = Math.round((Date.now() - peer.lastSeen) / 1000)
            const label = peer.alias ? ` — ${peer.alias}` : ""
            const ver = peer.version ? ` [v${peer.version}]` : ""
            const transports = peer.endpoints?.map((e) => e.transport).join(",") || "none"
            console.log(`  ${peer.agentId}${label}${ver}  [${transports}]  last seen ${ago}s ago`)
          }
        })

      awn
        .command("ping <agentId>")
        .description("Check if a peer is reachable")
        .action(async (agentId: string) => {
          console.log(`Pinging ${agentId}...`)
          const peer = getPeer(agentId)
          const ok = await pingPeer(agentId, peerPort, 5_000, peer?.endpoints)
          console.log(ok ? `Reachable` : `Unreachable`)
        })

      awn
        .command("send <agentId> <message>")
        .description("Send a direct message to a peer")
        .action(async (agentId: string, message: string) => {
          if (!identity) {
            console.error("Plugin not started. Restart the gateway first.")
            return
          }
          const result = await sendP2PMessage(identity, agentId, "chat", message, 8099, 10_000, buildSendOpts(agentId))
          if (result.ok) {
            console.log(`Message sent to ${agentId}`)
          } else {
            console.error(`Failed: ${result.error}`)
          }
        })

      awn
        .command("worlds")
        .description("Show joined worlds")
        .action(() => {
          if (_joinedWorlds.size === 0) {
            console.log("Not joined any worlds yet. Use 'openclaw join_world <id>' to join one.")
            return
          }
          console.log("=== Joined Worlds ===")
          for (const [id, info] of _joinedWorlds) {
            console.log(`  ${id} — ${info.address}:${info.port}`)
          }
        })
    },
    { commands: ["awn"] }
  )

  // ── Slash commands ─────────────────────────────────────────────────────────
  api.registerCommand({
    name: "awn-status",
    description: "Show AWN node status",
    handler: () => {
      if (!identity) return { text: "AWN: not started yet." }
      const peers = listPeers()
      const activeTransport = _transportManager?.active
      return {
        text: [
          `**AWN Node**`,
          `Agent ID: \`${identity.agentId}\``,
          `DID Key: \`${deriveDidKey(identity.publicKey)}\``,
          `Transport: ${activeTransport?.id ?? "http-only"}`,
          ...(_quicTransport?.isActive() ? [`QUIC: \`${_quicTransport.address}\``] : []),
          `Peers: ${peers.length} known`,
          `Worlds: ${_joinedWorlds.size} joined`,
        ].join("\n"),
      }
    },
  })

  api.registerCommand({
    name: "awn-peers",
    description: "List known AWN peers",
    handler: () => {
      const peers = listPeers()
      if (peers.length === 0) return { text: "No peers yet. Use `openclaw awn add <agent-id>`." }
      const lines = peers.map((p) => {
        const label = p.alias ? ` — ${p.alias}` : ""
        const ver = p.version ? ` [v${p.version}]` : ""
        return `\`${p.agentId}\`${label}${ver}`
      })
      return { text: `**Known Peers**\n${lines.join("\n")}` }
    },
  })

  // ── Agent tools ────────────────────────────────────────────────────────────
  api.registerTool({
    name: "p2p_send_message",
    description: "Send a direct encrypted P2P message to a peer by their agent ID.",
    parameters: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "The recipient's agent ID" },
        message: { type: "string", description: "The message content to send" },
        event: { type: "string", description: "Message event type (default 'chat'). Use 'world.join' to join a world." },
        port: { type: "integer", description: "Recipient's P2P server port (default 8099)" },
      },
      required: ["agent_id", "message"],
    },
    async execute(_id: string, params: { agent_id: string; message: string; event?: string; port?: number }) {
      if (!identity) {
        return { content: [{ type: "text", text: "Error: AWN service not started yet." }] }
      }
      const event = params.event ?? "chat"
      const result = await sendP2PMessage(identity, params.agent_id, event, params.message, params.port ?? 8099, 10_000, buildSendOpts(params.agent_id))
      if (result.ok) {
        return { content: [{ type: "text", text: `Message delivered to ${params.agent_id} (event: ${event})` }] }
      }
      return { content: [{ type: "text", text: `Failed to deliver: ${result.error}` }], isError: true }
    },
  })

  api.registerTool({
    name: "p2p_list_peers",
    description: "List all known peers. Optionally filter by capability prefix (e.g. 'world:' or 'world:pixel-city').",
    parameters: {
      type: "object",
      properties: {
        capability: { type: "string", description: "Filter peers by capability prefix (e.g. 'world:')" },
      },
      required: [],
    },
    async execute(_id: string, params: { capability?: string }) {
      const peers = params.capability
        ? findPeersByCapability(params.capability)
        : listPeers()
      if (peers.length === 0) {
        return { content: [{ type: "text", text: "No peers found." }] }
      }
      const lines = peers.map((p) => {
        const ago = Math.round((Date.now() - p.lastSeen) / 1000)
        const label = p.alias ? ` — ${p.alias}` : ""
        const ver = p.version ? ` [v${p.version}]` : ""
        const caps = p.capabilities?.length ? ` [${p.capabilities.join(", ")}]` : ""
        return `${p.agentId}${label}${ver}${caps} — last seen ${ago}s ago`
      })
      return { content: [{ type: "text", text: lines.join("\n") }] }
    },
  })

  api.registerTool({
    name: "p2p_status",
    description: "Get this node's agent ID and AWN service status.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute(_id: string, _params: Record<string, never>) {
      if (!identity) {
        return { content: [{ type: "text", text: "AWN service not started." }] }
      }
      const peers = listPeers()
      const activeTransport = _transportManager?.active
      const lines = [
        ...((_agentMeta.name) ? [`Agent name: ${_agentMeta.name}`] : []),
        `Agent ID: ${identity.agentId}`,
        `DID Key: ${deriveDidKey(identity.publicKey)}`,
        `Active transport: ${activeTransport?.id ?? "http-only"}`,
        ...(_quicTransport?.isActive() ? [`QUIC endpoint: ${_quicTransport.address}`] : []),
        `Plugin version: v${_agentMeta.version}`,
        `Known peers: ${peers.length}`,
        `Worlds joined: ${_joinedWorlds.size}`,
      ]
      return { content: [{ type: "text", text: lines.join("\n") }] }
    },
  })

  api.registerTool({
    name: "list_worlds",
    description: "List available Agent worlds from the World Registry and local cache.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute(_id: string, _params: Record<string, never>) {
      // Fetch from Gateway
      let registryWorlds: Array<{ agentId: string; alias?: string; endpoints?: Endpoint[]; capabilities?: string[]; lastSeen: number }> = []
      try {
        const resp = await fetch(`${getGatewayUrl()}/worlds`, { signal: AbortSignal.timeout(10_000) })
        if (resp.ok) {
          const data = await resp.json() as { worlds?: Array<{ worldId: string; agentId: string; name?: string; lastSeen?: number }> }
          for (const w of data.worlds ?? []) {
            if (w.agentId && !registryWorlds.some(rw => rw.agentId === w.agentId)) {
              registryWorlds.push({
                agentId: w.agentId,
                alias: w.name,
                capabilities: [`world:${w.worldId}`],
                lastSeen: w.lastSeen ?? Date.now(),
              })
              upsertDiscoveredPeer(w.agentId, "", {
                alias: w.name,
                capabilities: [`world:${w.worldId}`],
                source: "gateway",
              })
            }
          }
        }
      } catch { /* gateway unreachable */ }

      // Merge with local cache
      const localWorlds = findPeersByCapability("world:")
      const allWorlds = [...localWorlds]
      for (const rw of registryWorlds) {
        if (!allWorlds.some(w => w.agentId === rw.agentId)) {
          allWorlds.push(rw as any)
        }
      }

      if (!allWorlds.length) {
        return { content: [{ type: "text", text: "No worlds found. Use join_world with a world address to connect directly." }] }
      }
      const lines = allWorlds.map((p) => {
        const cap = p.capabilities?.find((c: string) => c.startsWith("world:")) ?? ""
        const worldId = cap.slice("world:".length)
        const ago = Math.round((Date.now() - (p.lastSeen ?? 0)) / 1000)
        const reachable = p.endpoints?.length ? "reachable" : "no endpoint"
        return `world:${worldId} — ${p.alias || worldId} [${reachable}] — last seen ${ago}s ago`
      })
      return { content: [{ type: "text", text: `Found ${allWorlds.length} world(s):\n${lines.join("\n")}` }] }
    },
  })

  api.registerTool({
    name: "join_world",
    description: "Join an Agent world. Provide a world_id (if already known) or address (host:port) to connect directly.",
    parameters: {
      type: "object",
      properties: {
        world_id: { type: "string", description: "The world ID (e.g. 'pixel-city') — looks up from known worlds" },
        address: { type: "string", description: "Direct address of the world server (e.g. 'example.com:8099' or '1.2.3.4:8099')" },
        alias: { type: "string", description: "Optional display name inside the world" },
      },
      required: [],
    },
    async execute(_id: string, params: { world_id?: string; address?: string; alias?: string }) {
      if (!identity) {
        return { content: [{ type: "text", text: "AWN service not started." }] }
      }
      if (!params.world_id && !params.address) {
        return { content: [{ type: "text", text: "Provide either world_id or address." }], isError: true }
      }

      let targetAddr: string
      let targetPort: number = peerPort
      let worldAgentId: string | undefined
      let worldPublicKey: string | undefined

      if (params.address) {
        const parsedAddress = parseDirectPeerAddress(params.address, peerPort)
        targetAddr = parsedAddress.address
        targetPort = parsedAddress.port

        const ping = await getPeerPingInfo(targetAddr, targetPort, 5_000)
        if (!ping.ok) {
          return { content: [{ type: "text", text: `World at ${params.address} is unreachable.` }], isError: true }
        }
        if (typeof ping.data?.agentId !== "string" || ping.data.agentId.length === 0) {
          return { content: [{ type: "text", text: `World at ${params.address} did not provide a stable agent ID.` }], isError: true }
        }
        if (typeof ping.data?.publicKey !== "string" || ping.data.publicKey.length === 0) {
          return { content: [{ type: "text", text: `World at ${params.address} did not provide a verifiable public key.` }], isError: true }
        }
        worldAgentId = ping.data.agentId
        worldPublicKey = ping.data.publicKey
      } else {
        const worlds = findPeersByCapability(`world:${params.world_id}`)
        if (!worlds.length) {
          return { content: [{ type: "text", text: `World '${params.world_id}' not found. Use address parameter to connect directly.` }] }
        }
        let world = worlds[0]
        if ((!world.endpoints?.length || !world.publicKey) && params.world_id) {
          const gatewayWorld = await fetchGatewayWorldRecord(params.world_id)
          if (gatewayWorld?.agentId) {
            upsertDiscoveredPeer(gatewayWorld.agentId, gatewayWorld.publicKey ?? "", {
              alias: gatewayWorld.alias ?? world.alias,
              capabilities: world.capabilities,
              endpoints: gatewayWorld.endpoints ?? world.endpoints,
              source: "gateway",
            })

            world = getPeer(gatewayWorld.agentId) ?? {
              ...world,
              agentId: gatewayWorld.agentId,
              alias: gatewayWorld.alias ?? world.alias,
              endpoints: gatewayWorld.endpoints ?? world.endpoints,
              publicKey: gatewayWorld.publicKey ?? world.publicKey,
            }
          }
        }
        if (!world.endpoints?.length) {
          return { content: [{ type: "text", text: `World '${params.world_id}' has no reachable endpoints.` }] }
        }
        targetAddr = world.endpoints[0].address
        targetPort = world.endpoints[0].port ?? peerPort
        worldAgentId = world.agentId
        worldPublicKey = getPeer(worldAgentId)?.publicKey ?? world.publicKey ?? ""
      }

      if (!worldPublicKey) {
        return { content: [{ type: "text", text: "World public key is unavailable; cannot verify signed membership refreshes." }], isError: true }
      }

      const myEndpoints: Endpoint[] = _agentMeta.endpoints ?? []
      if (myEndpoints.length === 0) {
        return {
          content: [{
            type: "text",
            text: "No reachable endpoint can be advertised. Set advertise_address (for HTTP/TCP) or configure QUIC before joining a world.",
          }],
          isError: true,
        }
      }
      const joinPayload = JSON.stringify({
        alias: params.alias ?? _agentMeta.name ?? identity.agentId.slice(0, 8),
        endpoints: myEndpoints,
      })

      const sendOpts = buildSendOpts(worldAgentId)
      sendOpts.expectedPublicKey = worldPublicKey
      const result = await sendP2PMessage(identity, targetAddr, "world.join", joinPayload, targetPort, 10_000, sendOpts)
      if (!result.ok) {
        return { content: [{ type: "text", text: `Failed to join world: ${result.error}` }], isError: true }
      }

      const worldId = (result.data?.worldId ?? params.world_id ?? params.address) as string
      const members = result.data?.members as unknown[] | undefined
      const memberCount = members?.length ?? 0
      const worldName = typeof result.data?.manifest === "object" && result.data?.manifest && typeof (result.data.manifest as { name?: unknown }).name === "string"
        ? (result.data.manifest as { name: string }).name
        : worldId

      upsertDiscoveredPeer(worldAgentId!, worldPublicKey, {
        alias: worldName,
        capabilities: [`world:${worldId}`],
        endpoints: [{ transport: "tcp", address: targetAddr, port: targetPort, priority: 1, ttl: 3600 }],
        source: "gossip",
      })

      const joinMembers = (result.data?.members as Array<{ agentId: string; alias?: string; endpoints?: Endpoint[] }> | undefined) ?? []
      syncWorldMembers(worldId, joinMembers)
      addWorldMembers(worldId, [worldAgentId!, ...joinMembers.map(m => m.agentId).filter(id => id !== identity!.agentId)])

      // Track this world for periodic member refresh
      _joinedWorlds.set(worldId, { agentId: worldAgentId!, address: targetAddr, port: targetPort, publicKey: worldPublicKey })
      _worldRefreshFailures.delete(worldId)
      if (!_memberRefreshTimer) {
        _memberRefreshTimer = setInterval(refreshWorldMembers, MEMBER_REFRESH_INTERVAL_MS)
      }

      return { content: [{ type: "text", text: `Joined world '${worldId}' — ${memberCount} other member(s) discovered` }] }
    },
  })
}
