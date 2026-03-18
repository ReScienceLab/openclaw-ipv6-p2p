export interface Endpoint {
  transport: string
  address: string
  port: number
  priority: number
  ttl?: number
}

export interface PeerRecord {
  agentId: string
  publicKey: string
  alias: string
  endpoints: Endpoint[]
  capabilities: string[]
  lastSeen: number
}

export interface Identity {
  agentId: string
  pubB64: string
  secretKey: Uint8Array
  keypair: { publicKey: Uint8Array; secretKey: Uint8Array }
}

export interface BootstrapNode {
  addr: string
  httpPort: number
}

export interface WorldManifest {
  name: string
  theme?: string
  description?: string
  objective?: string
  rules?: string[]
  actions?: Record<string, { params?: Record<string, string>; desc: string }>
  state_fields?: string[]
  [key: string]: unknown
}

export interface WorldConfig {
  worldId: string
  /**
   * Called after peer routes are registered but before the server starts listening.
   * Use this to register additional Fastify routes (e.g. static files, REST endpoints).
   */
  setupRoutes?: (fastify: import("fastify").FastifyInstance) => void | Promise<void>
  /** If provided, serve GET /.well-known/agent.json with a JWS-signed Agent Card */
  cardUrl?: string
  /** Agent name for the card (defaults to worldName) */
  cardName?: string
  /** Agent description for the card */
  cardDescription?: string
  worldName?: string
  worldTheme?: string
  /** Listen port (default 8099) */
  port?: number
  /** Externally reachable port for DAP announce, may differ in Docker (default = port) */
  publicPort?: number
  /** Public IP/hostname for announce endpoints */
  publicAddr?: string | null
  /** Persistence directory (default /data) */
  dataDir?: string
  /** Bootstrap node list URL */
  bootstrapUrl?: string
  /** Max agents allowed; 0 = unlimited (default 0) */
  maxAgents?: number
  /** Whether to announce to DAP network (default true) */
  isPublic?: boolean
  /** Password required to join (default "" = none) */
  password?: string
  /** World state broadcast interval in ms (default 5000) */
  broadcastIntervalMs?: number
  /** Bootstrap discovery interval in ms (default 600000) */
  discoveryIntervalMs?: number
  /** Stale peer TTL in ms (default 30min) */
  staleTtlMs?: number
}

export interface WorldHooks {
  /** Called when an agent sends world.join. Return manifest + optional initial state. */
  onJoin(agentId: string, data: Record<string, unknown>): Promise<{ manifest: WorldManifest; state?: unknown }>
  /** Called when an agent sends world.action. */
  onAction(agentId: string, data: Record<string, unknown>): Promise<{ ok: boolean; state?: unknown }>
  /** Called when an agent sends world.leave or is evicted. */
  onLeave(agentId: string): Promise<void>
  /** Returns current world snapshot for broadcast. */
  getState(): unknown
}

export interface WorldServer {
  /** Underlying Fastify instance — register additional routes here */
  fastify: import("fastify").FastifyInstance
  identity: Identity
  stop(): Promise<void>
}

// ── Key rotation (AgentWorld v0.2 §6.10/§10.4) ────────────────────────────────

export interface KeyRotationIdentity {
  agentId: string
  kid: string
  publicKeyMultibase: string
}

export interface KeyRotationProof {
  protected: string
  signature: string
}

export interface KeyRotationRequest {
  type: "agentworld-identity-rotation"
  version: string
  logicalCardUrl?: string
  oldAgentId: string
  newAgentId: string
  oldIdentity: KeyRotationIdentity
  newIdentity: KeyRotationIdentity
  timestamp: number
  /** ISO-8601: when rotation is effective */
  effectiveAt?: string
  /** ISO-8601: end of overlap window where old key is still accepted */
  overlapUntil?: string
  reason?: string
  proofs: {
    signedByOld: KeyRotationProof
    signedByNew: KeyRotationProof
  }
}
