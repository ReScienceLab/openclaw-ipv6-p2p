/**
 * DAP — OpenClaw plugin entry point.
 *
 * Agent ID (sha256(publicKey)[:16]) is the primary peer identifier.
 * Network addresses (Yggdrasil IPv6, QUIC endpoint) are transport-layer concerns.
 */
import * as os from "os"
import * as path from "path"
import { execSync } from "child_process"
import { loadOrCreateIdentity, getActualIpv6 } from "./identity"
import { startYggdrasil, stopYggdrasil, isYggdrasilAvailable, detectExternalYggdrasil, getYggdrasilNetworkInfo } from "./yggdrasil"
import { initDb, listPeers, upsertPeer, removePeer, getPeer, flushDb, getPeerIds, getEndpointAddress } from "./peer-db"
import { startPeerServer, stopPeerServer, getInbox, setSelfMeta, handleUdpMessage } from "./peer-server"
import { sendP2PMessage, pingPeer, broadcastLeave, SendOptions } from "./peer-client"
import { bootstrapDiscovery, startDiscoveryLoop, stopDiscoveryLoop, DEFAULT_BOOTSTRAP_PEERS } from "./peer-discovery"
import { upsertDiscoveredPeer } from "./peer-db"
import { buildChannel, wireInboundToGateway, CHANNEL_CONFIG_SCHEMA } from "./channel"
import { Identity, YggdrasilInfo, PluginConfig, Endpoint } from "./types"
import { TransportManager } from "./transport"
import { YggdrasilTransport } from "./transport-yggdrasil"
import { UDPTransport } from "./transport-quic"

const DAP_TOOLS = [
  "p2p_add_peer", "p2p_discover", "p2p_list_peers",
  "p2p_send_message", "p2p_status", "yggdrasil_check",
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
let yggInfo: YggdrasilInfo | null = null
let dataDir: string = path.join(os.homedir(), ".openclaw", "dap")
let peerPort: number = 8099
let _testMode: boolean = false
let _startupTimer: ReturnType<typeof setTimeout> | null = null
let _bootstrapPeers: string[] = []
let _agentMeta: { name?: string; version?: string; endpoints?: Endpoint[] } = {}
let _transportManager: TransportManager | null = null
let _yggTransport: YggdrasilTransport | null = null
let _quicTransport: UDPTransport | null = null

function buildSendOpts(peerIdOrAddr?: string): SendOptions {
  const peer = peerIdOrAddr ? getPeer(peerIdOrAddr) : null
  return {
    endpoints: peer?.endpoints,
    quicTransport: _quicTransport?.isActive() ? _quicTransport : undefined,
  }
}

function tryConnectExternalDaemon(): YggdrasilInfo | null {
  if (_yggTransport && identity) {
    const ok = _yggTransport.tryHotConnect(identity)
    if (ok) {
      yggInfo = _yggTransport.info
      return yggInfo
    }
  }
  const ext = detectExternalYggdrasil()
  if (!ext || !identity) return null
  yggInfo = ext
  identity.yggIpv6 = ext.address
  console.log(`[p2p] Hot-connected to external daemon: ${ext.address}`)
  return ext
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
      const extraPeers: string[] = cfg.yggdrasil_peers ?? []
      _bootstrapPeers = cfg.bootstrap_peers ?? []
      const discoveryIntervalMs: number = cfg.discovery_interval_ms ?? 10 * 60 * 1000
      const pluginVersion: string = require("../package.json").version
      _agentMeta = { name: cfg.agent_name ?? api.config?.identity?.name, version: pluginVersion }

      const rawTestMode = cfg.test_mode ?? "auto"
      const testMode = rawTestMode === "auto" ? !isYggdrasilAvailable() : rawTestMode
      _testMode = testMode

      if (rawTestMode === "auto") {
        console.log(`[p2p] test_mode=auto -> resolved to ${testMode ? "true (yggdrasil not found)" : "false (yggdrasil available)"}`)
      } else {
        console.log(`[p2p] test_mode=${testMode} (explicit config override)`)
      }

      const isFirstRun = !require("fs").existsSync(path.join(dataDir, "identity.json"))
      identity = loadOrCreateIdentity(dataDir)
      initDb(dataDir)

      console.log(`[p2p] Agent ID:  ${identity.agentId}`)
      if (_agentMeta.name) {
        console.log(`[p2p] Name:      ${_agentMeta.name}`)
      }

      _transportManager = new TransportManager()
      _yggTransport = new YggdrasilTransport()
      _quicTransport = new UDPTransport()

      _transportManager.register(_quicTransport)
      if (!testMode) {
        _transportManager.register(_yggTransport)
      }

      const quicPort = cfg.quic_port ?? 8098
      const activeTransport = await _transportManager.start(identity, {
        dataDir,
        extraPeers,
        testMode,
        quicPort,
      })

      if (activeTransport) {
        console.log(`[p2p] Active transport: ${activeTransport.id} -> ${activeTransport.address}`)
        _agentMeta.endpoints = _transportManager.getEndpoints()

        if (_yggTransport.isActive()) {
          yggInfo = _yggTransport.info
          if (yggInfo) {
            identity.yggIpv6 = yggInfo.address
            console.log(`[p2p] Yggdrasil: ${yggInfo.address}  (subnet: ${yggInfo.subnet})`)
          }
        } else if (testMode) {
          const actualIpv6 = getActualIpv6()
          if (actualIpv6) {
            identity.yggIpv6 = actualIpv6
            console.log(`[p2p] Test mode: using actual IPv6 ${actualIpv6}`)
          }
        }

        if (_quicTransport.isActive()) {
          console.log(`[p2p] QUIC endpoint: ${_quicTransport.address}`)
          _quicTransport.onMessage((from, data) => {
            handleUdpMessage(data, from)
          })
        }
      } else {
        console.warn("[p2p] No transport available — falling back to local-only mode")
        if (testMode) {
          const actualIpv6 = getActualIpv6()
          if (actualIpv6) {
            identity.yggIpv6 = actualIpv6
          }
        }
      }

      await startPeerServer(peerPort, { testMode, yggdrasilActive: _yggTransport?.isActive() ?? false })

      setSelfMeta({
        agentId: identity.agentId,
        publicKey: identity.publicKey,
        ..._agentMeta,
      })

      wireInboundToGateway(api)

      if (isFirstRun) {
        const quicActive = _quicTransport?.isActive()
        const welcomeLines = [
          "Welcome to DAP P2P!",
          "",
          `Your Agent ID: ${identity.agentId}`,
          yggInfo
            ? `Yggdrasil: ${yggInfo.address}`
            : quicActive
              ? `QUIC transport active: ${_quicTransport!.address}\nFor full overlay networking, run: openclaw p2p setup`
              : "Yggdrasil is not set up yet. Run: openclaw p2p setup",
          "",
          "Quick start:",
          "  openclaw p2p status    — show your agent ID",
          "  openclaw p2p discover  — find peers on the network",
          "  openclaw p2p send <id> <msg>  — send a message",
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

      const defaultDelay = (yggInfo && yggInfo.pid > 0) ? 30_000 : 5_000
      const startupDelayMs = cfg.startup_delay_ms ?? defaultDelay
      console.log(`[p2p] Discovery starts in ${startupDelayMs / 1000}s`)
      _startupTimer = setTimeout(async () => {
        _startupTimer = null
        console.log(`[p2p:discovery] Starting bootstrap — agentId: ${identity?.agentId}`)
        await bootstrapDiscovery(identity!, peerPort, _bootstrapPeers, _agentMeta)
        startDiscoveryLoop(identity!, peerPort, discoveryIntervalMs, _bootstrapPeers, _agentMeta)
      }, startupDelayMs)
    },

    stop: async () => {
      if (_startupTimer) {
        clearTimeout(_startupTimer)
        _startupTimer = null
      }
      stopDiscoveryLoop()
      if (identity) {
        await broadcastLeave(identity, listPeers(), peerPort, buildSendOpts())
      }
      flushDb()
      await stopPeerServer()
      if (_transportManager) {
        await _transportManager.stop()
        _transportManager = null
      }
      stopYggdrasil()
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
          aliases: ["p2p", "ygg"],
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
            const peer = getPeer(agentId)
            const addr = (peer ? getEndpointAddress(peer, "yggdrasil") : null) ?? agentId
            const r = await sendP2PMessage(identity, addr, "chat", text, peerPort, 10_000, buildSendOpts(agentId))
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
          console.log(`Version:        v${_agentMeta.version}`)
          console.log(`Transport:      ${_transportManager?.active?.id ?? "none"}`)
          if (_yggTransport?.isActive()) {
            console.log(`Yggdrasil:      ${yggInfo?.address ?? identity.yggIpv6}`)
          }
          if (_quicTransport?.isActive()) {
            console.log(`QUIC endpoint:  ${_quicTransport.address}`)
          }
          console.log(`Peer port:      ${peerPort}`)
          console.log(`Known peers:    ${listPeers().length}`)
          console.log(`Inbox messages: ${getInbox().length}`)
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
        .command("add <agentId>")
        .description("Add a peer by agent ID")
        .option("-a, --alias <alias>", "Human-readable alias for this peer")
        .action((agentId: string, opts: { alias?: string }) => {
          upsertPeer(agentId, opts.alias ?? "")
          console.log(`Peer added: ${agentId}${opts.alias ? ` (${opts.alias})` : ""}`)
        })

      p2p
        .command("remove <agentId>")
        .description("Remove a peer")
        .action((agentId: string) => {
          removePeer(agentId)
          console.log(`Peer removed: ${agentId}`)
        })

      p2p
        .command("ping <agentId>")
        .description("Check if a peer is reachable")
        .action(async (agentId: string) => {
          console.log(`Pinging ${agentId}...`)
          const peer = getPeer(agentId)
          const addr = (peer ? getEndpointAddress(peer, "yggdrasil") : null) ?? agentId
          const ok = await pingPeer(addr, peerPort, 5_000, peer?.endpoints)
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
          const peer = getPeer(agentId)
          const addr = (peer ? getEndpointAddress(peer, "yggdrasil") : null) ?? agentId
          const result = await sendP2PMessage(identity, addr, "chat", message, 8099, 10_000, buildSendOpts(agentId))
          if (result.ok) {
            console.log(`Message sent to ${agentId}`)
          } else {
            console.error(`Failed: ${result.error}`)
          }
        })

      p2p
        .command("discover")
        .description("Trigger an immediate DHT peer discovery round")
        .action(async () => {
          if (!identity) {
            console.error("Plugin not started. Restart the gateway first.")
            return
          }
          const cfg: PluginConfig = api.config?.plugins?.entries?.["dap"]?.config ?? {}
          const bootstrapPeers: string[] = cfg.bootstrap_peers ?? []
          const all = [...DEFAULT_BOOTSTRAP_PEERS, ...bootstrapPeers]
          console.log(`Discovering peers via ${all.length || "0"} bootstrap node(s)...`)
          const found = await bootstrapDiscovery(identity, peerPort, bootstrapPeers, _agentMeta)
          console.log(`Discovery complete — ${found} new peer(s) found. Total: ${listPeers().length}`)
        })

      p2p
        .command("inbox")
        .description("Show received messages")
        .action(() => {
          const msgs = getInbox()
          if (msgs.length === 0) {
            console.log("No messages received yet.")
            return
          }
          console.log("=== Inbox ===")
          for (const m of msgs.slice(0, 20)) {
            const time = new Date(m.receivedAt).toLocaleTimeString()
            console.log(`  [${time}] from ${m.from}: ${m.content}`)
          }
        })

      p2p
        .command("setup")
        .description("Install and configure Yggdrasil for P2P connectivity")
        .action(() => {
          const scriptPath = require("path").resolve(__dirname, "..", "scripts", "setup-yggdrasil.sh")
          let found = ""
          if (require("fs").existsSync(scriptPath)) found = scriptPath
          const isRoot = process.getuid?.() === 0
          if (found) {
            const cmd = isRoot ? `bash "${found}"` : `sudo bash "${found}"`
            if (!isRoot) console.log("This script requires root privileges. Requesting sudo...")
            try {
              require("child_process").execSync(cmd, { stdio: "inherit" })
            } catch {
              console.error("Setup script failed. Run manually: sudo bash " + found)
            }
          } else {
            console.log("Yggdrasil setup script:")
            console.log("  curl -fsSL https://raw.githubusercontent.com/ReScienceLab/DAP/main/scripts/setup-yggdrasil.sh | sudo bash")
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
          `Transport: ${activeTransport?.id ?? "none"}`,
          ...(_yggTransport?.isActive() ? [`Yggdrasil: \`${yggInfo?.address ?? identity.yggIpv6}\``] : []),
          ...(_quicTransport?.isActive() ? [`QUIC: \`${_quicTransport.address}\``] : []),
          `Peers: ${peers.length} known`,
          `Inbox: ${getInbox().length} messages`,
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
    name: "p2p_add_peer",
    description: "Add a remote OpenClaw agent as a P2P peer using their agent ID.",
    parameters: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "The peer's agent ID (16-char hex string)",
        },
        alias: {
          type: "string",
          description: "Optional human-readable name for this peer",
        },
      },
      required: ["agent_id"],
    },
    async execute(_id: string, params: { agent_id: string; alias?: string }) {
      upsertPeer(params.agent_id, params.alias ?? "")
      const label = params.alias ? ` (${params.alias})` : ""
      return { content: [{ type: "text", text: `Peer added: ${params.agent_id}${label}` }] }
    },
  })

  api.registerTool({
    name: "p2p_send_message",
    description: "Send a direct encrypted P2P message to a peer by their agent ID.",
    parameters: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "The recipient's agent ID" },
        message: { type: "string", description: "The message content to send" },
        port: { type: "integer", description: "Recipient's P2P server port (default 8099)" },
      },
      required: ["agent_id", "message"],
    },
    async execute(_id: string, params: { agent_id: string; message: string; port?: number }) {
      if (!identity) {
        return { content: [{ type: "text", text: "Error: P2P service not started yet." }] }
      }
      const peer = getPeer(params.agent_id)
      const addr = (peer ? getEndpointAddress(peer, "yggdrasil") : null) ?? params.agent_id
      const result = await sendP2PMessage(identity, addr, "chat", params.message, params.port ?? 8099, 10_000, buildSendOpts(params.agent_id))
      if (result.ok) {
        return { content: [{ type: "text", text: `Message delivered to ${params.agent_id}` }] }
      }
      return { content: [{ type: "text", text: `Failed to deliver: ${result.error}` }], isError: true }
    },
  })

  api.registerTool({
    name: "p2p_list_peers",
    description: "List all known P2P peers.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute(_id: string, _params: Record<string, never>) {
      const peers = listPeers()
      if (peers.length === 0) {
        return { content: [{ type: "text", text: "No peers yet." }] }
      }
      const lines = peers.map((p) => {
        const ago = Math.round((Date.now() - p.lastSeen) / 1000)
        const label = p.alias ? ` — ${p.alias}` : ""
        const ver = p.version ? ` [v${p.version}]` : ""
        return `${p.agentId}${label}${ver} — last seen ${ago}s ago`
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
      const inbox = getInbox()
      const activeTransport = _transportManager?.active
      const lines = [
        ...((_agentMeta.name) ? [`Agent name: ${_agentMeta.name}`] : []),
        `Agent ID: ${identity.agentId}`,
        `Active transport: ${activeTransport?.id ?? "none"}`,
        ...(_yggTransport?.isActive() ? [`Yggdrasil: ${yggInfo?.address ?? identity.yggIpv6}`] : []),
        ...(_quicTransport?.isActive() ? [`QUIC endpoint: ${_quicTransport.address}`] : []),
        `Plugin version: v${_agentMeta.version}`,
        `Known peers: ${peers.length}`,
        `Unread inbox: ${inbox.length} messages`,
      ]
      return { content: [{ type: "text", text: lines.join("\n") }] }
    },
  })

  api.registerTool({
    name: "p2p_discover",
    description: "Trigger an immediate DHT peer discovery round.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute(_id: string, _params: Record<string, never>) {
      if (!identity) {
        return { content: [{ type: "text", text: "P2P service not started." }] }
      }
      const cfg: PluginConfig = api.config?.plugins?.entries?.["dap"]?.config ?? {}
      const bootstrapPeers: string[] = cfg.bootstrap_peers ?? []
      const found = await bootstrapDiscovery(identity, peerPort, bootstrapPeers, _agentMeta)
      const total = listPeers().length
      return { content: [{ type: "text", text: `Discovery complete — ${found} new peer(s) found. Known peers: ${total}` }] }
    },
  })

  api.registerTool({
    name: "yggdrasil_check",
    description: "Diagnose Yggdrasil installation and daemon status.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute(_id: string, _params: Record<string, never>) {
      const binaryAvailable = isYggdrasilAvailable()

      if (yggInfo) {
        const netInfo = getYggdrasilNetworkInfo()
        const lines = [
          `Status: Ready`,
          `Agent ID: ${identity?.agentId}`,
          `Yggdrasil: ${yggInfo.address}`,
          `Known peers: ${listPeers().length}`,
        ]
        if (netInfo) {
          lines.push(`Network peers: ${netInfo.peerCount} (${netInfo.publicPeers} public)`)
        }
        return { content: [{ type: "text", text: lines.join("\n") }] }
      }

      const connected = tryConnectExternalDaemon()
      if (connected) {
        bootstrapDiscovery(identity!, peerPort, _bootstrapPeers, _agentMeta).catch(() => {})
        return {
          content: [{ type: "text", text:
            `Status: Ready (just connected)\nAgent ID: ${identity?.agentId}\nYggdrasil: ${connected.address}\nPeer discovery started in background.`
          }],
        }
      }

      const action = binaryAvailable
        ? "Yggdrasil is installed but no daemon is running."
        : "Yggdrasil is not installed."
      const quicStatus = _quicTransport?.isActive()
        ? `\nQUIC fallback: active (${_quicTransport.address})\nP2P messaging works without Yggdrasil via QUIC transport.`
        : ""
      return {
        content: [{ type: "text", text:
          `Status: ${_quicTransport?.isActive() ? "Degraded (QUIC only)" : "Setup needed"}\n${action}${quicStatus}\n\n` +
          `For full Yggdrasil overlay, run:\n  openclaw p2p setup\n\nAfter setup, call yggdrasil_check again — it will connect automatically.`
        }],
      }
    },
  })
}
