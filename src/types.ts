// ── Transport types ──────────────────────────────────────────────────────────

export type TransportType = "yggdrasil" | "quic" | "tailscale" | "tcp"

export interface Endpoint {
  transport: TransportType
  address: string
  port: number
  priority: number      // lower = preferred (0 = best)
  ttl: number           // seconds until this endpoint should be re-resolved
}

// ── Identity types ──────────────────────────────────────────────────────────

export interface Identity {
  agentId: string       // hex(sha256(publicKey))[:32] — permanent anchor
  publicKey: string     // base64 Ed25519 public key
  privateKey: string    // base64 Ed25519 private key (never leaves local storage)
  cgaIpv6?: string      // runtime: CGA-derived address (used internally by Ygg transport)
  yggIpv6?: string      // runtime: Yggdrasil address (set by transport layer, not persisted)
}

export interface YggdrasilInfo {
  address: string
  subnet: string
  pid: number
}

// ── Wire protocol types ─────────────────────────────────────────────────────

export interface P2PMessage {
  from: string          // sender's agentId
  publicKey: string     // sender's Ed25519 public key base64 (for TOFU)
  event: "chat" | "ping" | "pong" | "leave" | string
  content: string
  timestamp: number
  signature: string     // Ed25519 sig over canonical JSON (all fields except signature)
}

export interface PeerAnnouncement {
  from: string
  publicKey: string
  alias?: string
  version?: string
  endpoints: Endpoint[]
  capabilities?: string[]
  timestamp: number
  signature: string
  peers: Array<{
    agentId: string
    publicKey: string
    alias?: string
    endpoints: Endpoint[]
    lastSeen: number
  }>
}

// ── Peer record types ───────────────────────────────────────────────────────

export interface PeerRecord {
  agentId: string
  publicKey: string
  alias: string
  endpoints: Endpoint[]
  capabilities: string[]
  firstSeen: number
  lastSeen: number
}

export interface DiscoveredPeerRecord extends PeerRecord {
  discoveredVia?: string
  source: "manual" | "bootstrap" | "gossip"
  version?: string
}

// ── Plugin config ───────────────────────────────────────────────────────────

export interface PluginConfig {
  agent_name?: string
  peer_port?: number
  quic_port?: number
  data_dir?: string
  yggdrasil_peers?: string[]
  test_mode?: boolean | "auto"
  bootstrap_peers?: string[]
  discovery_interval_ms?: number
  startup_delay_ms?: number
}

// ── Key rotation (future) ───────────────────────────────────────────────────

export interface KeyRotation {
  agentId: string
  oldPublicKey: string
  newPublicKey: string
  timestamp: number
  signatureByOldKey: string
  signatureByNewKey: string
}
