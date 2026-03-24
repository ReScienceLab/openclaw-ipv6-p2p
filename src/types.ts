// ── Transport types ──────────────────────────────────────────────────────────

export type TransportType = "quic" | "tailscale" | "tcp"

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

export interface AgentAnnouncement {
  from: string
  publicKey: string
  alias?: string
  version?: string
  endpoints: Endpoint[]
  capabilities?: string[]
  timestamp: number
  signature: string
  agents: Array<{
    agentId: string
    publicKey: string
    alias?: string
    endpoints: Endpoint[]
    lastSeen: number
  }>
}

// ── Agent record types ──────────────────────────────────────────────────────

export interface AgentRecord {
  agentId: string
  publicKey: string
  alias: string
  endpoints: Endpoint[]
  capabilities: string[]
  firstSeen: number
  lastSeen: number
}

export interface DiscoveredAgentRecord extends AgentRecord {
  tofuCachedAt?: number   // timestamp when TOFU binding was first established
  discoveredVia?: string
  source: "manual" | "bootstrap" | "gossip" | "gateway"
  version?: string
}

// ── Plugin config ───────────────────────────────────────────────────────────

export interface PluginConfig {
  agent_name?: string
  peer_port?: number
  quic_port?: number
  data_dir?: string
  tofu_ttl_days?: number
  /** Explicitly advertised public address (IP or hostname) for peer endpoints. */
  advertise_address?: string
  /** Explicitly advertised public port for QUIC transport. */
  advertise_port?: number
}

// ── AgentWorld HTTP signing headers ────────────────────────────────────────────

export interface AwRequestHeaders {
  "X-AgentWorld-Version": string
  "X-AgentWorld-From": string
  "X-AgentWorld-KeyId": string
  "X-AgentWorld-Timestamp": string
  "Content-Digest": string
  "X-AgentWorld-Signature": string
}

export interface AwResponseHeaders {
  "X-AgentWorld-Version": string
  "X-AgentWorld-From": string
  "X-AgentWorld-KeyId": string
  "X-AgentWorld-Timestamp": string
  "Content-Digest": string
  "X-AgentWorld-Signature": string
}

// ── Key rotation ──────────────────────────────────────────────────────────────

export interface KeyRotationIdentity {
  agentId: string
  kid: string
  publicKeyMultibase: string
}

export interface KeyRotationProof {
  protected: string
  signature: string
}

export interface KeyRotationRequestV2 {
  type: "agentworld-identity-rotation"
  version: string
  logicalCardUrl?: string
  oldAgentId: string
  newAgentId: string
  oldIdentity: KeyRotationIdentity
  newIdentity: KeyRotationIdentity
  timestamp: number
  effectiveAt?: string
  overlapUntil?: string
  reason?: string
  proofs: {
    signedByOld: KeyRotationProof
    signedByNew: KeyRotationProof
  }
}
