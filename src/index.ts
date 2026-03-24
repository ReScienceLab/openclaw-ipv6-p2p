/**
 * AWN — Agent World Network — OpenClaw plugin entry point.
 *
 * Agent ID (sha256(publicKey)[:16]) is the primary agent identifier.
 * Transport is plain HTTP over TCP; QUIC is available as a fast optional transport.
 */
import * as os from "os"
import * as path from "path"
import { execSync } from "child_process"
import { loadOrCreateIdentity, deriveDidKey, verifyHttpResponseHeaders, agentIdFromPublicKey } from "./identity"
import { initDb, listAgents, getAgent, flushDb, getAgentIds, setTofuTtl, removeAgent, findAgentsByCapability } from "./agent-db"
import { initWorldDb, listWorlds, getWorld, getWorldBySlug, upsertWorld, flushWorldDb } from "./world-db"
import { startAgentServer, stopAgentServer, setSelfMeta, handleUdpMessage, addWorldMembers, setWorldMembers, removeWorld, clearWorldMembers } from "./agent-server"
import { sendP2PMessage, pingAgent, broadcastLeave, SendOptions, getAgentPingInfo } from "./agent-client"
import { upsertDiscoveredAgent } from "./agent-db"
import { buildChannel, wireInboundToGateway, CHANNEL_CONFIG_SCHEMA } from "./channel"
import { Identity, PluginConfig, Endpoint, DiscoveredWorldRecord } from "./types"
import { TransportManager } from "./transport"
import { UDPTransport } from "./transport-quic"
import { parseDirectPeerAddress } from "./address"

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

// Action param/schema types (mirrors agent-world-sdk ActionParamSchema/ActionSchema)
interface ActionParamSchema {
  type: string
  required?: boolean
  desc?: string
  min?: number
  max?: number
  enum?: Array<string | number>
}

interface ActionSchema {
  desc: string
  params?: Record<string, ActionParamSchema>
  phase?: string[]
}

// Track joined worlds for periodic member refresh
interface JoinedWorldInfo {
  agentId: string
  slug?: string
  address: string
  port: number
  publicKey: string
  manifest?: {
    name: string
    description?: string
    objective?: string
    type?: string
    theme?: string
    actions?: Record<string, ActionSchema>
    rules?: Array<{ id?: string; text: string; enforced: boolean }>
    lifecycle?: Record<string, unknown>
  }
}
const _joinedWorlds = new Map<string, JoinedWorldInfo>()
const _worldMembersByWorld = new Map<string, Set<string>>()
const _worldScopedPeerWorlds = new Map<string, Set<string>>()
const _worldRefreshFailures = new Map<string, number>()
let _memberRefreshTimer: ReturnType<typeof setInterval> | null = null
let _welcomeTimer: ReturnType<typeof setTimeout> | null = null
const MEMBER_REFRESH_INTERVAL_MS = 30_000
const WORLD_MEMBER_REFRESH_FAILURE_LIMIT = 3

function formatActionSignature(name: string, action: ActionSchema): string {
  const params = action.params
  if (!params || Object.keys(params).length === 0) {
    return `${name}() — ${action.desc}`
  }
  const parts: string[] = []
  for (const [pName, schema] of Object.entries(params)) {
    const optional = schema.required === false ? "?" : ""
    let typeStr: string
    if (schema.enum && schema.enum.length > 0) {
      typeStr = schema.enum.map(v => typeof v === "string" ? `"${v}"` : String(v)).join("|")
    } else {
      typeStr = schema.type || "unknown"
    }
    const constraints: string[] = []
    if (schema.min !== undefined && schema.max !== undefined) {
      constraints.push(`${schema.min}..${schema.max}`)
    } else if (schema.max !== undefined) {
      constraints.push(`max ${schema.max}`)
    } else if (schema.min !== undefined) {
      constraints.push(`min ${schema.min}`)
    }
    const suffix = constraints.length ? `[${constraints.join(", ")}]` : ""
    parts.push(`${pName}${optional}: ${typeStr}${suffix}`)
  }
  return `${name}(${parts.join(", ")}) — ${action.desc}`
}

function formatActionsBlock(actions: Record<string, ActionSchema>, indent = "  "): string {
  return Object.entries(actions)
    .map(([name, action]) => `${indent}${formatActionSignature(name, action)}`)
    .join("\n")
}

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
  if (getAgent(agentId)?.source !== "manual") {
    removeAgent(agentId)
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

    const existingAgent = getAgent(member.agentId)
    if (!existingAgent || existingAgent.source !== "manual") {
      upsertDiscoveredAgent(member.agentId, "", {
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
  const peer = peerIdOrAddr ? getAgent(peerIdOrAddr) : null
  return {
    endpoints: peer?.endpoints,
    quicTransport: _quicTransport?.isActive() ? _quicTransport : undefined,
    expectedPublicKey: peer?.publicKey || undefined,
  }
}

function getGatewayUrl(): string {
  return (process.env.GATEWAY_URL ?? "https://gateway.agentworlds.ai").replace(/\/+$/, "")
}

async function fetchGatewayWorldRecord(worldId: string): Promise<{
  worldId?: string
  slug?: string
  endpoints?: Endpoint[]
  publicKey?: string
} | null> {
  try {
    const resp = await fetch(`${getGatewayUrl()}/worlds/${encodeURIComponent(worldId)}`, {
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
    const protocolWorldId = typeof detail.worldId === "string"
      ? detail.worldId
      : undefined
    const slug = typeof detail.slug === "string"
      ? detail.slug
      : typeof detail.alias === "string"
        ? detail.alias
        : typeof detail.name === "string"
          ? detail.name
          : undefined

    return { worldId: protocolWorldId, slug, endpoints, publicKey }
  } catch {
    return null
  }
}

async function syncWorldsFromGateway(): Promise<DiscoveredWorldRecord[]> {
  const gatewayWorlds: DiscoveredWorldRecord[] = []
  try {
    const resp = await fetch(`${getGatewayUrl()}/worlds`, { signal: AbortSignal.timeout(10_000) })
    if (!resp.ok) return gatewayWorlds

    const data = await resp.json() as {
      worlds?: Array<{ worldId: string; slug?: string; endpoints?: Endpoint[]; publicKey?: string; lastSeen?: number }>
    }

    for (const world of data.worlds ?? []) {
      if (!world.worldId || gatewayWorlds.some((item) => item.worldId === world.worldId)) continue
      const nextWorld: DiscoveredWorldRecord = {
        worldId: world.worldId,
        slug: world.slug ?? world.worldId,
        publicKey: world.publicKey ?? "",
        endpoints: world.endpoints ?? [],
        lastSeen: world.lastSeen ?? Date.now(),
        source: "gateway",
      }
      gatewayWorlds.push(nextWorld)
      upsertWorld(nextWorld.worldId, nextWorld)
    }
  } catch { /* gateway unreachable */ }
  return gatewayWorlds
}

function resolveKnownWorld(identifier: string | undefined): DiscoveredWorldRecord | null {
  if (!identifier) return null
  return getWorld(identifier) ?? getWorldBySlug(identifier)
}

function resolveJoinedWorld(identifier: string | undefined): [string, JoinedWorldInfo] | null {
  if (!identifier) return null
  const direct = _joinedWorlds.get(identifier)
  if (direct) return [identifier, direct]

  for (const [worldId, info] of _joinedWorlds) {
    if (info.slug === identifier) return [worldId, info]
  }
  return null
}

export default function register(api: any) {
  api.registerService({
    id: "awn-node",

    start: async () => {
      ensurePluginAllowed(api.config)
      ensureChannelConfig(api.config)

      const cfg: PluginConfig = api.config?.plugins?.entries?.["awn"]?.config ?? {}
      dataDir = cfg.data_dir ?? dataDir
      peerPort = cfg.peer_port ?? peerPort
      const pluginVersion: string = require("../package.json").version
      _agentMeta = { name: cfg.agent_name ?? api.config?.identity?.name, version: pluginVersion }

      const isFirstRun = !require("fs").existsSync(path.join(dataDir, "identity.json"))
      identity = loadOrCreateIdentity(dataDir)
      initDb(dataDir)
      initWorldDb(dataDir)
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

      await startAgentServer(peerPort, { identity })

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
          "  openclaw join_world <worldId|slug> — join a world to discover agents",
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

      console.log(`[awn] Ready — join a world to discover agents`)
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
        await broadcastLeave(identity, listAgents(), peerPort, buildSendOpts())
      }
      flushDb()
      flushWorldDb()
      await stopAgentServer()
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
          listAccountIds: () => (identity ? getAgentIds() : []),
          resolveAccount: (_: unknown, accountId: string | undefined) => {
            const peer = accountId ? getAgent(accountId) : null
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
          console.log(`Listen port:      ${peerPort}`)
          console.log(`Known agents:    ${listAgents().length}`)
          console.log(`Worlds joined:  ${_joinedWorlds.size}`)
        })

      awn
        .command("agents")
        .description("List known agents")
        .action(() => {
          const agents = listAgents()
          if (agents.length === 0) {
            console.log("No agents yet. Use 'openclaw awn add <agent-id>' to add one.")
            return
          }
          console.log("=== Known Agents ===")
          for (const agent of agents) {
            const ago = Math.round((Date.now() - agent.lastSeen) / 1000)
            const label = agent.alias ? ` — ${agent.alias}` : ""
            const ver = agent.version ? ` [v${agent.version}]` : ""
            const transports = agent.endpoints?.map((e) => e.transport).join(",") || "none"
            console.log(`  ${agent.agentId}${label}${ver}  [${transports}]  last seen ${ago}s ago`)
          }
        })

      awn
        .command("ping <agentId>")
        .description("Check if an agent is reachable")
        .action(async (agentId: string) => {
          console.log(`Pinging ${agentId}...`)
          const peer = getAgent(agentId)
          const ok = await pingAgent(agentId, peerPort, 5_000, peer?.endpoints)
          console.log(ok ? `Reachable` : `Unreachable`)
        })

      awn
        .command("send <agentId> <message>")
        .description("Send a direct message to an agent")
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
            const label = info.slug ?? id
            const name = info.manifest?.name ?? label
            console.log(`  ${label} — ${name} (${info.address}:${info.port}) [id ${id}]`)
            const actions = info.manifest?.actions
            if (actions && Object.keys(actions).length > 0) {
              const actionList = Object.entries(actions).map(([k, v]) => `${k} (${v.desc})`).join(", ")
              console.log(`    Actions: ${actionList}`)
            }
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
      const agents = listAgents()
      const activeTransport = _transportManager?.active
      return {
        text: [
          `**AWN Node**`,
          `Agent ID: \`${identity.agentId}\``,
          `DID Key: \`${deriveDidKey(identity.publicKey)}\``,
          `Transport: ${activeTransport?.id ?? "http-only"}`,
          ...(_quicTransport?.isActive() ? [`QUIC: \`${_quicTransport.address}\``] : []),
          `Known agents: ${agents.length}`,
          `Worlds: ${_joinedWorlds.size} joined`,
        ].join("\n"),
      }
    },
  })

  api.registerCommand({
    name: "awn-agents",
    description: "List known AWN agents",
    handler: () => {
      const agents = listAgents()
      if (agents.length === 0) return { text: "No agents yet. Use `openclaw awn add <agent-id>`." }
      const lines = agents.map((p) => {
        const ago = Math.round((Date.now() - p.lastSeen) / 1000)
        const label = p.alias ? ` — ${p.alias}` : ""
        const ver = p.version ? ` [v${p.version}]` : ""
        const caps = p.capabilities?.length ? ` [${p.capabilities.join(", ")}]` : ""
        return `${p.agentId}${label}${ver}${caps} — last seen ${ago}s ago`
      })
      return { text: `**Known Agents**\n${lines.join("\n")}` }
    },
  })

}
