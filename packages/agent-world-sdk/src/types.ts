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

// ── World manifest types ───────────────────────────────────────────────────────

export interface ActionParamSchema {
  type: string
  required?: boolean
  desc?: string
  min?: number
  max?: number
  enum?: Array<string | number>
}

export interface ActionSchema {
  desc: string
  params?: Record<string, ActionParamSchema>
  phase?: string[]
}

export interface WorldRule {
  id?: string
  text: string
  enforced: boolean
}

export interface HostInfo {
  agentId: string
  name?: string
  description?: string
  cardUrl?: string
  endpoints?: Endpoint[]
}

export interface WorldLifecycle {
  matchmaking?: "arena" | "free"
  evictionPolicy?: "idle" | "loser-leaves" | "manual"
  idleTimeoutMs?: number
  turnTimeoutMs?: number
  turnTimeoutAction?: "default-move" | "forfeit"
}

export interface WorldManifest {
  name: string
  type?: "programmatic" | "hosted"
  theme?: string
  description?: string
  objective?: string
  rules?: WorldRule[]
  actions?: Record<string, ActionSchema>
  host?: HostInfo
  lifecycle?: WorldLifecycle
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
  /** World type: "programmatic" (default) or "hosted" */
  worldType?: "programmatic" | "hosted"
  /** Hosted mode: Host Agent's agentId */
  hostAgentId?: string
  /** Hosted mode: Host Agent's Agent Card URL */
  hostCardUrl?: string
  /** Hosted mode: Host Agent's direct endpoints */
  hostEndpoints?: Endpoint[]
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
  /** Append-only event ledger for agent activity */
  ledger: import("./world-ledger.js").WorldLedger
  stop(): Promise<void>
}

// ── World Ledger (append-only event log) ───────────────────────────────────────

export type LedgerEvent =
  | "world.genesis"
  | "world.join"
  | "world.leave"
  | "world.evict"
  | "world.action"

export interface LedgerEntry {
  seq: number
  prevHash: string
  timestamp: number
  event: LedgerEvent
  agentId: string
  alias?: string
  data?: Record<string, unknown>
  hash: string
  worldSig: string
}

export interface AgentSummary {
  agentId: string
  alias: string
  firstSeen: number
  lastSeen: number
  actions: number
  joins: number
  online: boolean
}

export interface LedgerQueryOpts {
  agentId?: string
  event?: LedgerEvent | LedgerEvent[]
  since?: number
  until?: number
  limit?: number
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
