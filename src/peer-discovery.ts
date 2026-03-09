/**
 * DHT-style peer discovery via Bootstrap + Gossip exchange.
 *
 * Flow:
 *   1. On startup, connect to bootstrap nodes (hardcoded + config)
 *   2. POST /peer/announce to each bootstrap -> receive their peer list
 *   3. Add discovered peers to local store (keyed by agentId)
 *   4. Fanout: announce to a sample of newly-discovered peers (1 level deep)
 *   5. Periodic loop: re-announce to a random sample to keep the table fresh
 */

import { Identity, Endpoint } from "./types"
import { signMessage, agentIdFromPublicKey } from "./identity"
import { listPeers, upsertDiscoveredPeer, getPeersForExchange, pruneStale } from "./peer-db"

const BOOTSTRAP_JSON_URL =
  "https://resciencelab.github.io/DAP/bootstrap.json"

export interface BootstrapNode {
  yggAddr?: string
  quicAddr?: string
  httpPort: number
  udpPort?: number
}

export async function fetchRemoteBootstrapPeers(): Promise<BootstrapNode[]> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10_000)
    const resp = await fetch(BOOTSTRAP_JSON_URL, { signal: ctrl.signal })
    clearTimeout(timer)
    if (!resp.ok) return []
    const data = (await resp.json()) as {
      bootstrap_nodes?: {
        yggAddr?: string
        quicAddr?: string | null
        httpPort?: number
        port?: number
        udpPort?: number | null
      }[]
    }
    return (data.bootstrap_nodes ?? []).map((n) => ({
      yggAddr: n.yggAddr || undefined,
      quicAddr: n.quicAddr || undefined,
      httpPort: n.httpPort ?? n.port ?? 8099,
      udpPort: n.udpPort || undefined,
    }))
  } catch {
    console.warn("[p2p:discovery] Could not fetch remote bootstrap list — using hardcoded fallback")
    return []
  }
}

export const DEFAULT_BOOTSTRAP_PEERS: BootstrapNode[] = [
  { yggAddr: "200:697f:bda:1e8e:706a:6c5e:630b:51d", httpPort: 8099 },
  { yggAddr: "200:e1a5:b063:958:8f74:ec45:8eb0:e30e", httpPort: 8099 },
  { yggAddr: "200:9cf6:eaf1:7d3e:14b0:5869:2140:b618", httpPort: 8099 },
  { yggAddr: "202:adbc:dde1:e272:1cdb:97d0:8756:4f77", httpPort: 8099 },
  { yggAddr: "200:5ec6:62dd:9e91:3752:820c:98f5:5863", httpPort: 8099 },
]

const EXCHANGE_TIMEOUT_MS = 30_000
const MAX_FANOUT_PEERS = 5
const MAX_SHARED_PEERS = 20

let _discoveryTimer: NodeJS.Timeout | null = null

function buildAnnouncement(
  identity: Identity,
  meta: { name?: string; version?: string; endpoints?: Endpoint[] } = {}
): Record<string, unknown> {
  const myPeers = getPeersForExchange(MAX_SHARED_PEERS).map((p) => ({
    agentId: p.agentId,
    publicKey: p.publicKey,
    alias: p.alias || undefined,
    lastSeen: p.lastSeen,
    endpoints: p.endpoints ?? [],
  }))

  const ann: Record<string, unknown> = {
    from: identity.agentId,
    publicKey: identity.publicKey,
    timestamp: Date.now(),
    peers: myPeers,
    endpoints: meta.endpoints ?? [],
  }
  if (meta.name) ann.alias = meta.name
  if (meta.version) ann.version = meta.version
  return ann
}

/** Extract the host portion from an endpoint address (strip port if present). */
function hostFromAddress(addr: string): string {
  // [ipv6]:port → ipv6
  const bracketMatch = addr.match(/^\[([^\]]+)\]:(\d+)$/)
  if (bracketMatch) return bracketMatch[1]
  // ipv4:port → ipv4 (only if exactly one colon)
  const parts = addr.split(":")
  if (parts.length === 2 && /^\d+$/.test(parts[1])) return parts[0]
  return addr
}

/** Get a reachable address (host only) from a peer's endpoints, by priority (lower = preferred). */
function reachableAddr(peer: { agentId: string; endpoints?: Endpoint[] }): string | null {
  if (!peer.endpoints?.length) return null
  const sorted = [...peer.endpoints].sort((a, b) => a.priority - b.priority)
  return sorted[0] ? hostFromAddress(sorted[0].address) : null
}

export async function announceToNode(
  identity: Identity,
  targetAddr: string,
  port: number = 8099,
  meta: { name?: string; version?: string; endpoints?: Endpoint[] } = {}
): Promise<Array<{
  agentId: string
  publicKey: string
  alias?: string
  lastSeen: number
  endpoints?: Endpoint[]
}> | null> {
  const payload = buildAnnouncement(identity, meta)
  const signature = signMessage(identity.privateKey, payload)
  const announcement = { ...payload, signature }

  const isIpv6 = targetAddr.includes(":")
  const url = isIpv6
    ? `http://[${targetAddr}]:${port}/peer/announce`
    : `http://${targetAddr}:${port}/peer/announce`

  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), EXCHANGE_TIMEOUT_MS)
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(announcement),
      signal: ctrl.signal,
    })
    clearTimeout(timer)

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "")
      console.warn(`[p2p:discovery] Announce to ${targetAddr.slice(0, 20)}... rejected ${resp.status}: ${errText}`)
      return null
    }

    const body = await resp.json() as {
      ok: boolean
      self?: { agentId?: string; publicKey?: string; alias?: string; version?: string; endpoints?: Endpoint[] }
      peers?: any[]
    }

    if (body.self?.publicKey && body.self?.agentId) {
      upsertDiscoveredPeer(body.self.agentId, body.self.publicKey, {
        alias: body.self.alias,
        version: body.self.version,
        discoveredVia: body.self.agentId,
        source: "gossip",
        endpoints: body.self.endpoints,
      })
    }

    return (body.peers ?? []).map((p: any) => ({
      agentId: p.agentId ?? (p.publicKey ? agentIdFromPublicKey(p.publicKey) : null),
      publicKey: p.publicKey,
      alias: p.alias,
      lastSeen: p.lastSeen,
      endpoints: p.endpoints ?? [],
    })).filter((p: any) => p.agentId)
  } catch (err: any) {
    console.warn(`[p2p:discovery] Announce to ${targetAddr.slice(0, 20)}... error: ${err?.message}`)
    return null
  }
}

export async function bootstrapDiscovery(
  identity: Identity,
  port: number = 8099,
  extraBootstrap: string[] | BootstrapNode[] = [],
  meta: { name?: string; version?: string; endpoints?: Endpoint[] } = {}
): Promise<number> {
  const remoteNodes = await fetchRemoteBootstrapPeers()
  const normalizedExtra: BootstrapNode[] = (extraBootstrap as any[]).map((e) =>
    typeof e === "string" ? { yggAddr: e, httpPort: port } : e
  )

  const seen = new Set<string>()
  const bootstrapNodes: BootstrapNode[] = []
  for (const n of [...remoteNodes, ...DEFAULT_BOOTSTRAP_PEERS, ...normalizedExtra]) {
    const key = n.yggAddr || n.quicAddr || ""
    if (!key) continue
    if (key === identity.yggIpv6 || key === identity.agentId) continue
    if (seen.has(key)) continue
    seen.add(key)
    bootstrapNodes.push(n)
  }

  if (bootstrapNodes.length === 0) {
    console.log("[p2p:discovery] No bootstrap nodes configured — skipping initial discovery.")
    return 0
  }

  console.log(`[p2p:discovery] Bootstrapping via ${bootstrapNodes.length} node(s) (parallel)...`)

  let totalDiscovered = 0
  const fanoutCandidates: Array<{ addr: string }> = []

  const results = await Promise.allSettled(
    bootstrapNodes.map(async (node) => {
      const addr = node.yggAddr || node.quicAddr
      if (!addr) return { addr: "", peers: null }
      const peers = await announceToNode(identity, addr, node.httpPort, meta)
      return { addr, peers }
    })
  )

  for (const result of results) {
    if (result.status !== "fulfilled") continue
    const { addr, peers } = result.value
    if (!addr) continue
    if (!peers) {
      console.warn(`[p2p:discovery] Bootstrap ${addr.slice(0, 20)}... unreachable`)
      continue
    }

    for (const p of peers) {
      if (p.agentId === identity.agentId) continue
      upsertDiscoveredPeer(p.agentId, p.publicKey, {
        alias: p.alias,
        discoveredVia: addr,
        source: "bootstrap",
        lastSeen: p.lastSeen,
        endpoints: p.endpoints,
      })
      const peerAddr = reachableAddr(p)
      if (peerAddr) fanoutCandidates.push({ addr: peerAddr })
      totalDiscovered++
    }

    console.log(`[p2p:discovery] Bootstrap ${addr.slice(0, 20)}... -> +${peers.length} peers`)
  }

  const fanout = fanoutCandidates.slice(0, MAX_FANOUT_PEERS)
  await Promise.allSettled(
    fanout.map(({ addr }) =>
      announceToNode(identity, addr, port, meta).then((peers) => {
        if (!peers) return
        for (const p of peers) {
          if (p.agentId === identity.agentId) continue
          upsertDiscoveredPeer(p.agentId, p.publicKey, {
            alias: p.alias,
            discoveredVia: addr,
            source: "gossip",
            lastSeen: p.lastSeen,
            endpoints: p.endpoints,
          })
        }
      })
    )
  )

  console.log(`[p2p:discovery] Bootstrap complete — ${totalDiscovered} peers discovered`)
  return totalDiscovered
}

export function startDiscoveryLoop(
  identity: Identity,
  port: number = 8099,
  intervalMs: number = 10 * 60 * 1000,
  extraBootstrap: string[] | BootstrapNode[] = [],
  meta: { name?: string; version?: string; endpoints?: Endpoint[] } = {}
): void {
  if (_discoveryTimer) return

  const normalizedExtra: BootstrapNode[] = (extraBootstrap as any[]).map((e) =>
    typeof e === "string" ? { yggAddr: e, httpPort: port } : e
  )
  const protectedAddrs = [
    ...new Set([
      ...DEFAULT_BOOTSTRAP_PEERS.map((n) => n.yggAddr).filter((a): a is string => !!a),
      ...normalizedExtra.map((n) => n.yggAddr).filter((a): a is string => !!a),
    ]),
  ]

  const runGossip = async () => {
    pruneStale(3 * intervalMs, protectedAddrs)

    const peers = listPeers()
    if (peers.length === 0) return

    const sample = peers.sort(() => Math.random() - 0.5).slice(0, MAX_FANOUT_PEERS)

    let updated = 0
    await Promise.allSettled(
      sample.map(async (peer) => {
        const addr = reachableAddr(peer)
        if (!addr) return
        const received = await announceToNode(identity, addr, port, meta)
        if (!received) return
        upsertDiscoveredPeer(peer.agentId, peer.publicKey, {
          alias: peer.alias,
          discoveredVia: peer.agentId,
          source: "gossip",
          endpoints: peer.endpoints,
        })
        for (const p of received) {
          if (p.agentId === identity.agentId) continue
          upsertDiscoveredPeer(p.agentId, p.publicKey, {
            alias: p.alias,
            discoveredVia: peer.agentId,
            source: "gossip",
            lastSeen: p.lastSeen,
            endpoints: p.endpoints,
          })
          updated++
        }
      })
    )

    if (updated > 0) {
      console.log(`[p2p:discovery] Gossip round: +${updated} peer updates`)
    }
  }

  _discoveryTimer = setInterval(runGossip, intervalMs)
  console.log(`[p2p:discovery] Gossip loop started (interval: ${intervalMs / 1000}s)`)
}

export function stopDiscoveryLoop(): void {
  if (_discoveryTimer) {
    clearInterval(_discoveryTimer)
    _discoveryTimer = null
    console.log("[p2p:discovery] Gossip loop stopped")
  }
}
