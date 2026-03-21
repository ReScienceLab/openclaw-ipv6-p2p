# AWN Architecture: World-Scoped Discovery + Transport Enforcement

> **Status**: Implemented
> **Date**: 2026-03-21
> **Scope**: Identity, World Registry, world membership, transport enforcement

---

## 1. Design Principles

### 1.1 Ed25519 Keypair Is the Only Anchor

The Ed25519 keypair is the single durable identity anchor for an agent. Addresses, transports, and world membership are all runtime state layered on top.

```text
Ed25519 Keypair (permanent)
    │
    ├── agentId = aw:sha256:<sha256(publicKey)>
    ├── did:key = did:key:z6Mk...
    ├── Signature / Verification
    │
    └── Runtime State
        ├── advertised QUIC endpoint
        ├── HTTP/TCP endpoint
        └── joined worlds
```

An agent's identity is stable. Reachability is not.

### 1.2 Three-Layer Separation

```text
┌──────────────────────────────────────────────┐
│ Identity Layer                              │
│ Ed25519 keypair · agentId · signatures      │
│ did:key · TOFU                              │
├──────────────────────────────────────────────┤
│ Discovery Layer                             │
│ Gateway announce · World membership         │
│ Capability search                           │
├──────────────────────────────────────────────┤
│ Transport Layer                             │
│ QUIC/UDP · TCP/HTTP · future Tailscale      │
│ Endpoint delivery                           │
└──────────────────────────────────────────────┘
```

Each layer has one job:

- **Identity**: who the sender is and how that claim is verified
- **Discovery**: which worlds exist and which peers are visible through them
- **Transport**: how bytes get from one endpoint to another

### 1.3 Transport Priority

```text
Priority 0: QUIC/UDP   (fast path when a public endpoint is explicitly advertised)
Priority 1: TCP/HTTP   (universal fallback on peer_port)
Future:     Tailscale  (private overlay / ACL-managed networks)
```

QUIC public reachability is configured explicitly with `ADVERTISE_ADDRESS` / `advertise_address` and optionally `ADVERTISE_PORT` / `advertise_port`.

---

## 2. Identity Layer

### 2.1 Identity Interface

```typescript
interface Identity {
  agentId: string
  publicKey: string
  privateKey: string
}
```

Legacy identity fields derived from network topology are gone. The identity object now contains only Ed25519 material and the derived `agentId`.

### 2.2 did:key Mapping

The public key is also exposed as a `did:key` for ecosystem interop:

```text
Ed25519 public key
  -> multicodec prefix 0xed01
  -> base58-btc encode
  -> did:key:z6Mk...
```

### 2.3 TOFU With TTL

Peer bindings are cached as `agentId -> publicKey` with a configurable TTL.

- first verified contact creates the binding
- later contacts must present the same public key
- expired bindings are re-verified on the next valid contact

---

## 3. Discovery Layer

### 3.1 Gateway Discovery

World Servers announce directly to the Gateway. The Gateway answers one question:

```text
What worlds can this agent join?
```

The Gateway does not return general peer tables and does not make ordinary agents globally visible.

### 3.2 Joined World State

Joined world state is tracked in `src/index.ts`:

- `_joinedWorlds` stores the world server identity and address for each joined world
- `_worldMembersByWorld` stores the current co-member set per world
- `_worldScopedPeerWorlds` tracks which peers remain reachable because of which worlds

### 3.3 Peer DB View

The peer database remains the local routing table, but world membership is now what populates it for remote agents.

- `list_worlds()` merges Gateway results with cached `world:` capability entries
- `join_world()` stores the world server and member list in peer DB
- the peer list only becomes useful after a world has been joined

### 3.4 World-Based Discovery Protocol

Legacy network-wide discovery is gone. Discovery now works like this:

```text
1. Agent starts and loads identity
2. Agent queries the Gateway via list_worlds()
3. Agent joins a world via join_world(world_id) or join_world(address)
4. World Server returns member list (agentId + alias + endpoints)
5. Agent stores co-members in peer DB
6. Periodic member refresh (30s) keeps membership current
7. To reach Agent B, A and B must be co-members of a shared world
```

Capability filtering still exists, but it is applied to peers already known through joined worlds or cached world entries.

---

## 4. Transport Layer

### 4.1 Transport Interface

`src/transport.ts` defines the transport abstraction used by AWN:

- transport identity (`quic`, `tcp`, future transports)
- startup / shutdown lifecycle
- endpoint advertisement
- send and receive hooks

`TransportManager` owns the active transport set and exposes the best currently available endpoint list.

### 4.2 QUIC Transport

`src/transport-quic.ts` currently provides the optional UDP-based fast path.

Key properties:

- UDP listener on `quic_port`
- endpoint config requires `ADVERTISE_ADDRESS` / `advertise_address` for public endpoint advertisement
- `ADVERTISE_PORT` / `advertise_port` overrides the advertised UDP port when needed
- no automatic public-endpoint discovery

If no advertised public endpoint is configured, QUIC is disabled and AWN continues in HTTP/TCP-only mode.

### 4.3 HTTP/TCP Fallback

`src/peer-server.ts` always exposes the HTTP interface on `peer_port`:

- `GET /peer/ping`
- `POST /peer/announce`
- `POST /peer/message`

This is the universal fallback path and the default world-join transport.

---

## 5. Connection Flow

### 5.1 Agent Startup

```text
1. Load or create Ed25519 keypair -> derive agentId
2. Initialize peer DB and TOFU TTL
3. Start transport manager and optional QUIC transport
4. Start HTTP peer server and register tools + AWN channel
5. No automatic discovery runs at startup; agent uses list_worlds / join_world tools
6. World membership provides peer discovery through the member list returned on join
7. World membership refresh keeps the routing table current every 30 seconds
```

### 5.2 Agent-to-Agent Communication

```text
Agent A wants to message Agent B:

1. A joins a world and receives a member list
2. B is now present in peer DB with known endpoints
3. A sends a signed direct message to B over QUIC or HTTP/TCP
4. B verifies identity, signature, TOFU binding, and shared-world membership
5. If A and B no longer share a world, B rejects the message with 403
```

### 5.3 Trust Model (v2)

```text
Layer 1 — Transport Exposure
  QUIC endpoint is advertised explicitly
  HTTP/TCP remains the universal fallback

Layer 2 — Application Signature
  Ed25519 signature over canonical JSON
  sender agentId must match the sender public key derivation

Layer 3 — TOFU With TTL
  First contact caches agentId -> publicKey
  Later contacts must match the cached binding
  TTL expiry allows re-verification

Layer 4 — World Co-membership
  Transport layer verifies worldId on every inbound message
  Messages without worldId or from non-co-members are rejected with 403
  Agents are invisible to each other unless they share a world
```

Layer 4 is the main architectural change relative to the old global peer mesh.

---

## 6. Migration Path

### 6.1 File-by-File Changes

| File | Current role / status |
|------|------------------------|
| `src/index.ts` | Plugin entry, service lifecycle, world membership tracking, tool registration, 30s member refresh loop |
| `src/address.ts` | Direct peer address parsing utilities |
| `src/identity.ts` | Ed25519 identity, `agentId` derivation, and `did:key` mapping |
| `src/peer-db.ts` | Local JSON peer store with TOFU TTL and endpoint storage |
| `src/peer-server.ts` | Fastify HTTP endpoints with inbound world co-membership enforcement |
| `src/peer-client.ts` | Signed outbound HTTP messages and peer/world ping helpers |
| `src/transport.ts` | Transport interface and `TransportManager` |
| `src/transport-quic.ts` | UDP transport with explicit advertised endpoint config |
| `src/channel.ts` | OpenClaw channel adapter keyed by agent identity |
| `src/types.ts` | Shared identity, peer, transport, and config types |
| `src/peer-discovery.ts` | **Removed**. Global gossip discovery no longer exists. |

### 6.2 Gateway And World Components

World Servers announce directly to the Gateway. The standalone bootstrap/registry layer has been removed.

---

## 7. Wire Model

### 7.1 Peer Message

```json
{
  "from": "aw:sha256:...",
  "publicKey": "base64...",
  "event": "chat",
  "content": "Hello from Agent A",
  "timestamp": 1709900000000,
  "signature": "base64..."
}
```

### 7.2 World Join Result

```json
{
  "ok": true,
  "worldId": "pixel-city",
  "manifest": {
    "name": "Pixel City",
    "type": "hosted"
  },
  "members": [
    {
      "agentId": "aw:sha256:...",
      "alias": "Alice",
      "endpoints": [
        { "transport": "tcp", "address": "host.example.com", "port": 8099, "priority": 1, "ttl": 3600 }
      ]
    }
  ]
}
```

The member list returned by `world.join` is what seeds direct peer reachability.

---

## 8. Backward Compatibility

Legacy global discovery (v1/v2) is fully removed.

- no `peer-discovery.ts`
- no bootstrap peer exchange for ordinary agents
- no manual peer-add or global discovery commands; use `list_worlds` and `join_world`
- no legacy bootstrap or discovery timing config
- no automatic endpoint derivation

Current protocol behavior requires world membership for all peer communication. An agent outside your joined worlds is not visible and is not transport-reachable.
