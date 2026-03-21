/**
 * DAP — OpenClaw plugin entry point.
 *
 * Agent ID (sha256(publicKey)[:16]) is the primary peer identifier.
 * Transport is plain HTTP over TCP; QUIC is available as a fast optional transport.
 */
import * as os from "os"
import * as path from "path"
import { execSync } from "child_process"
import { loadOrCreateIdentity, deriveDidKey } from "./identity"
import { initDb, listPeers, getPeer, flushDb, getPeerIds, getEndpointAddress, setTofuTtl, findPeersByCapability } from "./peer-db"
import { startPeerServer, stopPeerServer, setSelfMeta, handleUdpMessage, addWorldMembers, removeWorld, clearWorldMembers } from "./peer-server"
import { sendP2PMessage, pingPeer, broadcastLeave, SendOptions } from "./peer-client"
import { upsertDiscoveredPeer } from "./peer-db"
import { buildChannel, wireInboundToGateway, CHANNEL_CONFIG_SCHEMA } from "./channel"
import { Identity, PluginConfig, Endpoint } from "./types"
import { TransportManager } from "./transport"
import { UDPTransport } from "./transport-quic"

const DAP_TOOLS = [
  "p2p_list_peers",
  "p2p_send_message", "p2p_status",
  "list_worlds", "join_world",
]

function ensureToolsAllowed(config: any): void {
  try {
    const alsoAllow: string[] = config?.tools?.alsoAllow ?? []
    const missing = DAP_TOOLS.filter(t => !alsoAllow.includes(t))
    if (missing.length === 0) return
    const merged = [...alsoAllow, ...missing]
    const jsonVal = JSON.stringify(merged)
    execSync(`openclaw config set tools.alsoAllow '${jsonVal}'`, { timeout: 5000, stdio: "ignore" })
    console.log(`[p2p] Auto-enabled ${missing.length} DAP tool(s) in tools.alsoAllow`)
  } catch {
    console.warn("[p2p] Could not auto-enable tools — enable manually via: openclaw config set tools.alsoAllow")
  }
}

function ensurePluginAllowed(config: any): void {
  try {
    const allow: string[] | undefined = config?.plugins?.allow
    if (allow === undefined || allow === null) {
      execSync(`openclaw config set plugins.allow '["dap"]'`, { timeout: 5000, stdio: "ignore" })
      console.log("[p2p] Set plugins.allow to [dap]")
      return
    }
    if (Array.isArray(allow) && !allow.includes("dap")) {
      const merged = [...allow, "dap"]
      execSync(`openclaw config set plugins.allow '${JSON.stringify(merged)}'`, { timeout: 5000, stdio: "ignore" })
      console.log("[p2p] Added dap to plugins.allow")
    }
  } catch { /* best effort */ }
}

function ensureChannelConfig(config: any): void {
  try {
    const channelCfg = config?.channels?.dap
    if (channelCfg && channelCfg.dmPolicy) return
    execSync(`openclaw config set channels.dap.dmPolicy '"pairing"'`, { timeout: 5000, stdio: "ignore" })
    console.log("[p2p] Set channels.dap.dmPolicy to pairing")
  } catch { /* best effort */ }
}

let identity: Identity | null = null
let dataDir: string = path.join(os.homedir(), ".openclaw", "dap")
let peerPort: number = 8099
let _agentMeta: { name?: string; version?: string; endpoints?: Endpoint[] } = {}
let _transportManager: TransportManager | null = null
let _quicTransport: UDPTransport | null = null

// Track joined worlds for periodic member refresh
const _joinedWorlds = new Map<string, { agentId: string; address: string; port: number }>()
let _memberRefreshTimer: ReturnType<typeof setInterval> | null = null
const MEMBER_REFRESH_INTERVAL_MS = 30_000

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
      if (!resp.ok) continue
      const body = await resp.json() as { members?: Array<{ agentId: string; alias?: string; endpoints?: Endpoint[] }> }
      const memberIds: string[] = []
      for (const member of body.members ?? []) {
        if (member.agentId === identity!.agentId) continue
        memberIds.push(member.agentId)
        upsertDiscoveredPeer(member.agentId, "", {
          alias: member.alias,
          endpoints: member.endpoints,
          source: "gossip",
        })
      }
      addWorldMembers(worldId, memberIds)
    } catch { /* world unreachable — skip */ }
  }
}

function buildSendOpts(peerIdOrAddr?: string): SendOptions {
  const peer = peerIdOrAddr ? getPeer(peerIdOrAddr) : null
  return {
    endpoints: peer?.endpoints,
    quicTransport: _quicTransport?.isActive() ? _quicTransport : undefined,
  }
}

export default function register(api: any) {
  api.registerService({
    id: "dap-node",

    start: async () => {
      ensurePluginAllowed(api.config)
      ensureToolsAllowed(api.config)
      ensureChannelConfig(api.config)

      const cfg: PluginConfig = api.config?.plugins?.entries?.["dap"]?.config ?? {}
      dataDir = cfg.data_dir ?? dataDir
      peerPort = cfg.peer_port ?? peerPort
      const pluginVersion: string = require("../package.json").version
      _agentMeta = { name: cfg.agent_name ?? api.config?.identity?.name, version: pluginVersion }

      const isFirstRun = !require("fs").existsSync(path.join(dataDir, "identity.json"))
      identity = loadOrCreateIdentity(dataDir)
      initDb(dataDir)
      if (cfg.tofu_ttl_days !== undefined) setTofuTtl(cfg.tofu_ttl_days)

      console.log(`[p2p] Agent ID:  ${identity.agentId}`)
      if (_agentMeta.name) {
        console.log(`[p2p] Name:      ${_agentMeta.name}`)
      }

      _transportManager = new TransportManager()
      _quicTransport = new UDPTransport()
      _transportManager.register(_quicTransport)

      const quicPort = cfg.quic_port ?? 8098
      const activeTransport = await _transportManager.start(identity, { dataDir, quicPort })

      if (activeTransport) {
        console.log(`[p2p] Active transport: ${activeTransport.id} -> ${activeTransport.address}`)
        _agentMeta.endpoints = _transportManager.getEndpoints()

        if (_quicTransport.isActive()) {
          console.log(`[p2p] QUIC endpoint: ${_quicTransport.address}`)
          _quicTransport.onMessage((from, data) => {
            handleUdpMessage(data, from)
          })
        }
      } else {
        console.warn("[p2p] No QUIC transport available — HTTP-only mode")
      }

      await startPeerServer(peerPort, { identity })

      setSelfMeta({
        agentId: identity.agentId,
        publicKey: identity.publicKey,
        ..._agentMeta,
      })

      wireInboundToGateway(api)

      if (isFirstRun) {
        const welcomeLines = [
          "Welcome to DAP P2P!",
          "",
          `Your Agent ID: ${identity.agentId}`,
          _quicTransport?.isActive()
            ? `QUIC transport active: ${_quicTransport.address}`
            : "Running in HTTP-only mode.",
          "",
          "Quick start:",
          "  openclaw p2p status     — show your agent ID",
          "  openclaw join_world <id> — join a world to discover peers",
        ]
        setTimeout(() => {
          try {
            api.gateway?.receiveChannelMessage?.({
              channelId: "dap",
              accountId: "system",
              text: welcomeLines.join("\n"),
              senderId: "dap-system",
            })
          } catch { /* best effort */ }
        }, 2000)
      }

      console.log(`[p2p] Ready — join a world to discover peers`)
    },

    stop: async () => {
      if (_memberRefreshTimer) {
        clearInterval(_memberRefreshTimer)
        _memberRefreshTimer = null
      }
      _joinedWorlds.clear()
      clearWorldMembers()
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
        id: "dap",
        meta: {
          id: "dap",
          label: "DAP",
          selectionLabel: "DAP (P2P)",
          docsPath: "/channels/dap",
          blurb: "Direct encrypted P2P messaging.",
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
      const p2p = program.command("p2p").description("P2P node management")

      p2p
        .command("status")
        .description("Show this node's agent ID and status")
        .action(() => {
          if (!identity) {
            console.log("Plugin not started yet. Try again after gateway restart.")
            return
          }
          console.log("=== P2P Node Status ===")
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

      p2p
        .command("peers")
        .description("List known peers")
        .action(() => {
          const peers = listPeers()
          if (peers.length === 0) {
            console.log("No peers yet. Use 'openclaw p2p add <agent-id>' to add one.")
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

      p2p
        .command("ping <agentId>")
        .description("Check if a peer is reachable")
        .action(async (agentId: string) => {
          console.log(`Pinging ${agentId}...`)
          const peer = getPeer(agentId)
          const ok = await pingPeer(agentId, peerPort, 5_000, peer?.endpoints)
          console.log(ok ? `Reachable` : `Unreachable`)
        })

      p2p
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

      p2p
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
    { commands: ["p2p"] }
  )

  // ── Slash commands ─────────────────────────────────────────────────────────
  api.registerCommand({
    name: "p2p-status",
    description: "Show P2P node status",
    handler: () => {
      if (!identity) return { text: "P2P: not started yet." }
      const peers = listPeers()
      const activeTransport = _transportManager?.active
      return {
        text: [
          `**P2P Node**`,
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
    name: "p2p-peers",
    description: "List known P2P peers",
    handler: () => {
      const peers = listPeers()
      if (peers.length === 0) return { text: "No peers yet. Use `openclaw p2p add <agent-id>`." }
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
        return { content: [{ type: "text", text: "Error: P2P service not started yet." }] }
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
    description: "List all known P2P peers. Optionally filter by capability prefix (e.g. 'world:' or 'world:pixel-city').",
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
    description: "Get this node's agent ID and P2P service status.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute(_id: string, _params: Record<string, never>) {
      if (!identity) {
        return { content: [{ type: "text", text: "P2P service not started." }] }
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
      // Fetch from registry
      let registryWorlds: Array<{ agentId: string; alias?: string; endpoints?: Endpoint[]; capabilities?: string[]; lastSeen: number }> = []
      try {
        const registryUrl = "https://resciencelab.github.io/DAP/bootstrap.json"
        const resp = await fetch(registryUrl, { signal: AbortSignal.timeout(10_000) })
        if (resp.ok) {
          const data = await resp.json() as { bootstrap_nodes?: Array<{ addr: string; httpPort?: number }> }
          const nodes = (data.bootstrap_nodes ?? []).filter((n: any) => n.addr)
          const results = await Promise.allSettled(nodes.slice(0, 5).map(async (node: any) => {
            const isIpv6 = node.addr.includes(":") && !node.addr.includes(".")
            const url = isIpv6
              ? `http://[${node.addr}]:${node.httpPort ?? 8099}/worlds`
              : `http://${node.addr}:${node.httpPort ?? 8099}/worlds`
            const wr = await fetch(url, { signal: AbortSignal.timeout(10_000) })
            if (!wr.ok) return []
            const body = await wr.json() as { worlds?: any[] }
            return body.worlds ?? []
          }))
          for (const r of results) {
            if (r.status !== "fulfilled") continue
            for (const w of r.value as any[]) {
              if (w.agentId && !registryWorlds.some(rw => rw.agentId === w.agentId)) {
                registryWorlds.push(w)
                upsertDiscoveredPeer(w.agentId, w.publicKey ?? "", {
                  alias: w.alias,
                  endpoints: w.endpoints,
                  capabilities: w.capabilities,
                  source: "gossip",
                })
              }
            }
          }
        }
      } catch { /* registry unreachable */ }

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
        return { content: [{ type: "text", text: "P2P service not started." }] }
      }
      if (!params.world_id && !params.address) {
        return { content: [{ type: "text", text: "Provide either world_id or address." }], isError: true }
      }

      let targetAddr: string
      let targetPort: number = peerPort
      let worldAgentId: string | undefined

      if (params.address) {
        const parts = params.address.split(":")
        targetPort = parts.length > 1 ? parseInt(parts[parts.length - 1]) || peerPort : peerPort
        targetAddr = parts.length > 1 ? parts.slice(0, -1).join(":") : parts[0]

        // Ping the world to get its agentId
        const ok = await pingPeer(targetAddr, targetPort, 5_000)
        if (!ok) {
          return { content: [{ type: "text", text: `World at ${params.address} is unreachable.` }], isError: true }
        }
        worldAgentId = targetAddr
      } else {
        const worlds = findPeersByCapability(`world:${params.world_id}`)
        if (!worlds.length) {
          return { content: [{ type: "text", text: `World '${params.world_id}' not found. Use address parameter to connect directly.` }] }
        }
        const world = worlds[0]
        if (!world.endpoints?.length) {
          return { content: [{ type: "text", text: `World '${params.world_id}' has no reachable endpoints.` }] }
        }
        targetAddr = world.endpoints[0].address
        targetPort = world.endpoints[0].port ?? peerPort
        worldAgentId = world.agentId
      }

      const myEndpoints: Endpoint[] = _agentMeta.endpoints ?? []
      const joinPayload = JSON.stringify({
        alias: params.alias ?? _agentMeta.name ?? identity.agentId.slice(0, 8),
        endpoints: myEndpoints,
      })

      const result = await sendP2PMessage(identity, worldAgentId!, "world.join", joinPayload, targetPort, 10_000, buildSendOpts(worldAgentId))
      if (!result.ok) {
        return { content: [{ type: "text", text: `Failed to join world: ${result.error}` }], isError: true }
      }

      // Populate peer DB + world membership allowlist from members list
      const worldId = (result.data?.worldId ?? params.world_id ?? params.address) as string
      const memberIds: string[] = [worldAgentId!]
      if (result.data?.members && Array.isArray(result.data.members)) {
        for (const member of result.data.members as Array<{ agentId: string; alias?: string; endpoints?: Endpoint[] }>) {
          if (member.agentId === identity.agentId) continue
          memberIds.push(member.agentId)
          upsertDiscoveredPeer(member.agentId, "", {
            alias: member.alias,
            endpoints: member.endpoints,
            source: "gossip",
          })
        }
      }
      addWorldMembers(worldId, memberIds)
      const members = result.data?.members as unknown[] | undefined
      const memberCount = members?.length ?? 0

      // Track this world for periodic member refresh
      _joinedWorlds.set(worldId, { agentId: worldAgentId!, address: targetAddr, port: targetPort })
      if (!_memberRefreshTimer) {
        _memberRefreshTimer = setInterval(refreshWorldMembers, MEMBER_REFRESH_INTERVAL_MS)
      }

      return { content: [{ type: "text", text: `Joined world '${worldId}' — ${memberCount} other member(s) discovered` }] }
    },
  })
}
