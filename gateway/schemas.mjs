// Reusable JSON Schema definitions for the AWN Gateway OpenAPI spec.
// Used by @fastify/swagger to auto-generate the spec at /docs.

export const ErrorSchema = {
  $id: "Error",
  type: "object",
  required: ["error"],
  properties: {
    error: { type: "string" },
  },
}

export const EndpointSchema = {
  $id: "Endpoint",
  type: "object",
  required: ["transport", "address", "port", "priority"],
  properties: {
    transport: { type: "string", enum: ["tcp"] },
    address: { type: "string" },
    port: { type: "integer" },
    priority: { type: "integer" },
    ttl: { type: "integer" },
  },
}

export const PeerRecordSchema = {
  $id: "PeerRecord",
  type: "object",
  required: ["agentId", "publicKey", "alias", "endpoints", "capabilities", "lastSeen"],
  properties: {
    agentId: { type: "string", description: "aw:sha256:{hex} agent identifier" },
    publicKey: { type: "string", description: "Base64-encoded Ed25519 public key" },
    alias: { type: "string" },
    endpoints: { type: "array", items: { $ref: "Endpoint#" } },
    capabilities: { type: "array", items: { type: "string" } },
    lastSeen: { type: "integer", description: "Unix timestamp (ms) of last announce or heartbeat" },
  },
}

export const WorldSummarySchema = {
  $id: "WorldSummary",
  type: "object",
  required: ["worldId", "agentId", "name", "endpoints", "reachable", "lastSeen"],
  properties: {
    worldId: { type: "string" },
    agentId: { type: "string" },
    name: { type: "string" },
    endpoints: { type: "array", items: { $ref: "Endpoint#" } },
    reachable: { type: "boolean" },
    lastSeen: { type: "integer" },
  },
}

export const WorldDetailSchema = {
  $id: "WorldDetail",
  type: "object",
  required: ["worldId", "agentId", "publicKey", "name", "endpoints", "reachable", "subscribers", "lastSeen"],
  properties: {
    worldId: { type: "string" },
    agentId: { type: "string" },
    publicKey: { type: "string" },
    name: { type: "string" },
    endpoints: { type: "array", items: { $ref: "Endpoint#" } },
    reachable: { type: "boolean" },
    subscribers: { type: "integer", description: "Number of active WebSocket subscribers" },
    lastSeen: { type: "integer" },
  },
}

export const AnnounceRequestSchema = {
  $id: "AnnounceRequest",
  type: "object",
  required: ["from", "publicKey", "alias", "endpoints", "capabilities", "timestamp", "signature"],
  properties: {
    from: { type: "string", description: "aw:sha256:{hex} agent identifier" },
    publicKey: { type: "string", description: "Base64-encoded Ed25519 public key" },
    alias: { type: "string" },
    version: { type: "string", default: "1.0.0" },
    endpoints: { type: "array", items: { $ref: "Endpoint#" } },
    capabilities: { type: "array", items: { type: "string" } },
    timestamp: { type: "integer" },
    signature: { type: "string", description: "Domain-separated Ed25519 signature (ANNOUNCE context)" },
  },
}

export const HeartbeatRequestSchema = {
  $id: "HeartbeatRequest",
  type: "object",
  required: ["agentId", "ts", "signature"],
  properties: {
    agentId: { type: "string", description: "aw:sha256:{hex} agent identifier" },
    ts: { type: "integer", description: "Unix timestamp (ms)" },
    signature: { type: "string", description: "Domain-separated Ed25519 signature (HEARTBEAT context)" },
  },
}

export const SignedMessageSchema = {
  $id: "SignedMessage",
  type: "object",
  required: ["from", "publicKey", "event", "content", "timestamp", "signature"],
  properties: {
    from: { type: "string", description: "aw:sha256:{hex} sender agent identifier" },
    publicKey: { type: "string", description: "Base64-encoded Ed25519 public key" },
    event: { type: "string", description: 'Message event type (e.g. "world.state")' },
    content: { type: "string", description: "JSON-encoded message content" },
    timestamp: { type: "integer" },
    signature: { type: "string", description: "Ed25519 signature over canonical payload" },
  },
}

export const allSchemas = [
  ErrorSchema,
  EndpointSchema,
  PeerRecordSchema,
  WorldSummarySchema,
  WorldDetailSchema,
  AnnounceRequestSchema,
  HeartbeatRequestSchema,
  SignedMessageSchema,
]
