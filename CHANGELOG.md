# Changelog

## 1.1.4

### Patch Changes

- 6637571: Fix plugin id mismatch: openclaw.plugin.json id changed from "awn" to "agent-world-network" to match the npm package name and eliminate the startup warning.
- 52fc219: Fix gateway /world/:worldId response missing publicKey field. join_world(world_id=...) was always failing with "World public key is unavailable; cannot verify signed membership refreshes" because the publicKey was stored on announce but omitted from the world record response.

## 1.1.3

### Patch Changes

- ed8440e: Merge peerServer into app: all /peer/\* routes now served on a single port (HTTP_PORT 8100) alongside /worlds and /health, fixing announce unreachability via GATEWAY_URL.

## 1.1.2

### Patch Changes

- d8c3085: Fix domain: agentsworlds.ai -> agentworlds.ai across all config and source files.
- f28e2ff: Fix deploy-gateway: remove -f from Cloudflare curl to expose API errors, skip DNS update when IP is already correct (idempotent with Elastic IP), downgrade Cloudflare API failures to warnings so deploys are not blocked.

## 1.1.1

### Patch Changes

- 3ef9266: Fix deploy-gateway workflow: replace ec2:DescribeInstances call with EC2_PUBLIC_IP repo variable to avoid IAM permission error.
- 79ec712: Bind gateway to https://gateway.agentsworlds.ai: add Cloudflare DNS upsert step to deploy-gateway workflow (proxied=true for automatic HTTPS via Cloudflare), expose HTTP API on port 80, inject PUBLIC_URL/PUBLIC_ADDR into the container. Centralise the gateway URL in package.json gateway.url and propagate it via sync-version.mjs to src/index.ts, web/client.js, and docs/index.html. The deploy workflow reads GATEWAY_URL from GitHub Actions vars with a fallback, so the domain can be overridden without touching code. Also fixes skills/awn/SKILL.md os value from macos to darwin.

## 1.1.0

### Minor Changes

- c134690: refactor: rename agent tools from `p2p_*` to `awn_*` prefix

  The `p2p_` prefix was inherited from the old DAP plugin and implied
  generic peer-to-peer semantics. These tools are AWN-specific — peer
  discovery is world-scoped, and messages are signed with the AWN protocol.

  **Breaking change:** the following tool names are renamed:

  | Old name           | New name           |
  | ------------------ | ------------------ |
  | `p2p_status`       | `awn_status`       |
  | `p2p_list_peers`   | `awn_list_peers`   |
  | `p2p_send_message` | `awn_send_message` |

  Update any `tools.alsoAllow` config entries and agent prompts that
  reference the old `p2p_*` names.

## 1.0.1

### Patch Changes

- 6c53162: fix(sdk): correct base58 encode/decode for leading-zero byte inputs

  `base58Encode([0])` produced `"11"` instead of `"1"` and `base58Decode("1")` produced
  `[0, 0]` instead of `[0]`. Fixed by skipping trailing zero digits in the encoder and
  rewriting the leading-zero byte handling in the decoder. Not triggered by current
  Ed25519 key usage but now correct for general reuse.

- 90b3bcf: fix(sdk): restrict world.state broadcasts to active world members only

  `broadcastWorldState()` previously used `peerDb.values()` as broadcast targets, leaking
  live world state to any discovered peer — even those that never joined the world. The
  broadcast now filters through `agentEndpoints` and `agentLastSeen` so only agents that
  successfully called `world.join` receive world state updates.

- 2429e1f: fix(sdk): validate newAgentId matches newPublicKey in key rotation handler

  The `/peer/key-rotation` endpoint verified `oldAgentId ↔ oldPublicKey` but never
  checked that `newAgentId` matches `newPublicKey`. An attacker could submit a rotation
  request with arbitrary `newAgentId` metadata. Added `agentIdFromPublicKey()` validation
  for the new identity, returning 400 on mismatch.

- 4045dfd: fix(sdk): protocol consistency — domain separator, ledger constant, Fastify reply

  - **Domain separator mismatch:** `broadcastWorldState()` body signature changed from
    `DOMAIN_SEPARATORS.WORLD_STATE` to `DOMAIN_SEPARATORS.MESSAGE` to match the
    `/peer/message` receiver verification.
  - **Ledger dead code:** Removed unused `LEDGER_DOMAIN` constant. Replaced fragile
    string-splitting `LEDGER_SEPARATOR` construction with direct `PROTOCOL_VERSION` usage.
  - **Fastify reply:** Added explicit `return reply.send(body)` in `/peer/message` handler
    to follow Fastify 5 async handler best practices.

## 1.0.0

### Major Changes

- 041b465: refactor!: remove bootstrap nodes — Gateway absorbs registry

  World Servers now announce directly to the Gateway via GATEWAY_URL,
  eliminating the standalone bootstrap/registry layer. The Gateway's
  existing peer infrastructure (/peer/announce, peer DB, /worlds) handles
  all world discovery.

  BREAKING CHANGE: The `bootstrapUrl` and `discoveryIntervalMs` config
  fields are replaced by `gatewayUrls` and `announceIntervalMs`. World
  Servers must set GATEWAY_URL instead of BOOTSTRAP_URL. The bootstrap/
  directory, docs/bootstrap.json, and bootstrap-health workflow are removed.

### Minor Changes

- 041b465: feat: Gateway persistence, graceful shutdown, and health observability

  - Rename internal peers → registry terminology for clarity
  - Persist world registry to $DATA_DIR/registry.json with atomic writes
  - Wire persistence into announce and prune flows for restart recovery
  - Stop /peer/message from polluting registry with empty records
  - Add graceful shutdown (SIGTERM/SIGINT) that flushes registry state
  - Enhance /health with registryAge, status (ready/warming/empty)

- c3a1701: feat!: transport-layer enforcement of world-scoped isolation

  All incoming peer messages are now verified at the transport layer before
  reaching application logic:

  - Messages without a worldId are rejected (403)
  - Messages with a worldId that doesn't match any joined world are rejected
  - Only co-members of a shared world can exchange messages
  - Added address.ts with parseHostPort() and parseDirectPeerAddress() utilities
  - Transport enforcement tests validate all rejection scenarios

  BREAKING CHANGE: Peers that are not co-members of a shared world can no
  longer send messages to each other. All messages must include a valid worldId.

- b74f700: feat: convert bootstrap nodes to World Registry

  Bootstrap nodes now function as a World Registry — they only accept and serve
  World Server registrations (peers with world:\* capabilities). Individual agent
  announcements are rejected with 403.

  - Bootstrap server rewritten as World Registry (only world:\* announces accepted)
  - New GET /worlds endpoint returns registered worlds
  - list_worlds queries registry nodes to discover available worlds
  - Removed peer-discovery.ts (global peer gossip no longer used)
  - World Servers auto-register on startup via existing startDiscovery() flow
  - Sibling sync between registry nodes preserved (world entries only)

- b74f700: feat!: world-scoped agent isolation — remove global peer gossip

  Agents are no longer visible to each other via bootstrap gossip. Peer discovery
  happens exclusively through World membership:

  - Remove bootstrap peer discovery (bootstrapDiscovery, startDiscoveryLoop, stopDiscoveryLoop)
  - Remove p2p_add_peer and p2p_discover tools
  - World Server returns `members` (agentId + alias + endpoints) in world.join response
  - Add `/world/members` authenticated endpoint (requires X-AgentWorld-From header of active member)
  - join_world accepts direct `address` parameter for connecting to worlds by URL
  - sendP2PMessage now returns response body data for join_world to extract member list
  - Agent endpoints are transmitted in join payload and stored server-side
  - Eviction cleans up agent endpoint tracking

  BREAKING CHANGE: Agents must join a World to discover and communicate with other agents.
  Bootstrap nodes no longer exchange individual agent information.

### Patch Changes

- c3a1701: fix: replace IPv6/STUN with ADVERTISE_ADDRESS + Codex P1 fixes

  Endpoint advertisement:

  - Removed unreliable IPv6 NIC scanning (getPublicIPv6, getActualIpv6, isGlobalUnicastIPv6)
  - Removed incomplete STUN NAT traversal from QUIC transport
  - Added ADVERTISE_ADDRESS / ADVERTISE_PORT env vars and plugin config for explicit endpoint advertisement
  - QUIC transport disabled without ADVERTISE_ADDRESS (no unusable loopback endpoints)

  Codex review P1 fixes:

  - Fixed bootstrap package.json resolution for Docker (use ./package.json not ../)
  - Added setWorldMembers() to revoke co-member access when membership shrinks
  - Verify X-AgentWorld-\* response signatures on /world/members before trusting member list
  - /peer/ping returns publicKey for join_world identity verification

- fbec06f: Update repository banner to Agent World Network design

## 0.5.0

### Minor Changes

- eb4863f: Implement domain-separated signatures to prevent cross-context replay attacks

  This is a BREAKING CHANGE that implements AgentWire-style domain separation across all signing contexts.

  ## Security Improvements

  - **Prevents cross-context replay attacks**: Signatures valid in one context (e.g., HTTP requests) cannot be replayed in another context (e.g., Agent Cards)
  - **Adds 7 domain separators**: HTTP_REQUEST, HTTP_RESPONSE, AGENT_CARD, KEY_ROTATION, ANNOUNCE, MESSAGE, WORLD_STATE
  - **Format**: `"AgentWorld-{Context}-{VERSION}\0"` (includes null byte terminator to prevent JSON confusion)
  - **Version format**: Domain separators use major.minor version (e.g., "0.4" instead of "0.4.3") to prevent network partitioning on patch releases

  ## Breaking Changes

  ### Signature Format

  All signatures now include a domain-specific prefix before the payload:

  ```
  message = DomainSeparator + JSON.stringify(canonicalize(payload))
  signature = Ed25519(message, secretKey)
  ```

  ### Affected APIs

  - `signHttpRequest()` - Now uses `DOMAIN_SEPARATORS.HTTP_REQUEST`
  - `verifyHttpRequestHeaders()` - Verifies with domain separation
  - `signHttpResponse()` - Now uses `DOMAIN_SEPARATORS.HTTP_RESPONSE`
  - `verifyHttpResponseHeaders()` - Verifies with domain separation
  - `buildSignedAgentCard()` - Agent Card JWS now prepends `DOMAIN_SEPARATORS.AGENT_CARD`
  - Peer protocol (announce, message, key-rotation) - All use context-specific separators

  ### New Exports

  - `DOMAIN_SEPARATORS` - Constant object with all 7 domain separators
  - `signWithDomainSeparator(separator, payload, secretKey)` - Low-level signing function
  - `verifyWithDomainSeparator(separator, publicKey, payload, signature)` - Low-level verification function

  ## Version Management

  Protocol version is extracted from package.json as **major.minor only**:

  - **Patch releases** (0.4.3 → 0.4.4): Maintain signature compatibility - domain separators unchanged ("0.4")
  - **Minor/major releases** (0.4.x → 0.5.0): Change domain separators - breaking change ("0.4" → "0.5")

  Examples:

  - Package version `0.4.3` → Domain separator contains `0.4`
  - Package version `0.5.0-beta.1` → Domain separator contains `0.5`
  - Package version `1.0.0` → Domain separator contains `1.0`

  This prevents network partitioning on bug-fix releases while maintaining protocol versioning on minor/major updates.

  ## Migration Guide

  ### For Signature Verification

  Existing signatures created before this change will NOT verify. All agents must upgrade simultaneously or use a coordinated rollout strategy.

  ### For Custom Signing

  If you were using `signPayload()` or `verifySignature()` directly, migrate to domain-separated versions:

  **Before:**

  ```typescript
  const sig = signPayload(payload, secretKey);
  const valid = verifySignature(publicKey, payload, sig);
  ```

  **After:**

  ```typescript
  const sig = signWithDomainSeparator(
    DOMAIN_SEPARATORS.MESSAGE,
    payload,
    secretKey
  );
  const valid = verifyWithDomainSeparator(
    DOMAIN_SEPARATORS.MESSAGE,
    publicKey,
    payload,
    sig
  );
  ```

  ## Agent Card Capability

  Agent Cards now advertise `"domain-separated-signatures"` capability in the conformance block.

  ## Verification

  All existing tests pass + 19 new domain separation security tests covering cross-context replay attack prevention.

- eb4863f: feat: domain-separated signing, header-only auth, world ledger

  - DAP plugin HTTP signing/verification aligned with SDK domain separators (HTTP_REQUEST, HTTP_RESPONSE)
  - QUIC/UDP buildSignedMessage uses DOMAIN_SEPARATORS.MESSAGE (matching server verification)
  - Key rotation uses DOMAIN_SEPARATORS.KEY_ROTATION
  - Header signatures (X-AgentWorld-\*) required on announce/message — no legacy body-only fallback
  - Blockchain-inspired World Ledger: append-only event log with SHA-256 hash chain, Ed25519-signed entries, JSON Lines persistence, /world/ledger + /world/agents HTTP endpoints
  - Collision-resistant ledger filenames via SHA-256(worldId)

- eb4863f: feat: add world type system — programmatic and hosted world modes

  Extends WorldManifest with structured rules, actions schema, host info, and lifecycle config.
  Extends WorldConfig with worldType and host agent fields.
  createWorldServer auto-injects host info on join for hosted worlds.

## 0.4.3

### Patch Changes

- d056d07: fix: use cd instead of --prefix for SDK npm publish to avoid publishing root package

## 0.4.2

### Patch Changes

- fe2a12a: fix: add NPM_TOKEN env to release workflow for changesets publish detection

## 0.4.1

### Patch Changes

- df08054: fix: install and build agent-world-sdk in CI workflows

## 0.4.0

### Minor Changes

- c7f958c: Agent Worlds Playground — world discovery UI, manifest protocol, and updated web frontend
- 379c2c9: feat(agentwire-p0): add AgentWire v0.2 HTTP header signing and eliminate gateway crypto duplication

  - Add `signHttpRequest`, `verifyHttpRequestHeaders`, `computeContentDigest` to agent-world-sdk crypto module
  - Update `peer-protocol.ts` to verify `X-AgentWire-*` headers with backward-compatible body-sig fallback
  - Update `bootstrap.ts` and `world-server.ts` to send `X-AgentWire-*` headers on all outbound requests
  - Refactor `gateway/server.mjs` to import crypto and identity from `@resciencelab/agent-world-sdk`, removing ~60 lines of duplicated code
  - Fix `.gitignore` to properly exclude `.worktrees/` directory

- 379c2c9: feat(agentwire-p1): AgentWire v0.2 agentId namespace + Agent Card

  BREAKING: agentId format changed from 32-char truncated hex to `aw:sha256:<64hex>`.
  Existing identity files are migrated automatically on next startup.
  Bootstrap nodes must be redeployed after this release.

  New: GET /.well-known/agent.json — JWS-signed A2A Agent Card with
  extensions.agentwire block (agentId, identity key, profiles, conformance).
  Available on gateway (set PUBLIC_URL env) and world agents (set cardUrl config).

- b819b00: feat(p2): response signing, key rotation format, Agent Card ETag + capabilities

  - HTTP response signing: all `/peer/*` JSON responses include `X-AgentWorld-Signature` + `Content-Digest`
  - Key rotation: structured `agentworld-identity-rotation` format with JWS proofs, top-level `oldAgentId`/`newAgentId`
  - TOFU guard: key-loss recovery returns 403 (silent overwrite no longer allowed)
  - Agent Card: `ETag` + `Cache-Control` headers, `conformance.capabilities` array
  - Protocol version derived from `package.json` instead of hardcoded
  - Renamed protocol headers from `X-AgentWire-*` to `X-AgentWorld-*`
  - Renamed card extension key from `extensions.agentwire` to `extensions.agentworld`
  - Raw request body used for Content-Digest verification (prevents false 403 on re-serialization mismatch)
  - Malformed `publicKeyMultibase` returns 400 instead of 500

- dcd4f1c: Add UDP socket listener (port 8098) to bootstrap nodes for QUIC peer rendezvous and NAT endpoint discovery
- a434a0b: Add capability-based peer discovery: findPeersByCapability() with exact and prefix matching, capability filter on p2p_list_peers tool and CLI
- 0d92856: Rename DeClaw to DAP across the package, plugin IDs, config keys, and public-facing docs.
- 7512bcc: Add Gateway Server (gateway/server.mjs) — stateless portal with WebSocket bridge connecting DAP network to browsers
- da658a5: Add list_worlds and join_world agent tools for discovering and joining Agent worlds via DAP
- dcd4f1c: Add POST /peer/key-rotation endpoint: both old and new Ed25519 keys sign the rotation record, TOFU cache is updated atomically
- d59aefa: Add @resciencelab/agent-world-sdk — reusable DAP World Agent infrastructure (crypto, identity, peer DB, bootstrap discovery, peer protocol, createWorldServer API)
- dcd4f1c: Remove Yggdrasil dependency. DAP now uses plain HTTP over TCP as its primary transport (with QUIC as an optional fast transport). This eliminates the need to install and run a Yggdrasil daemon, reducing agent onboarding to installing the plugin only.

  Breaking changes:

  - `PluginConfig.yggdrasil_peers` removed — use `bootstrap_peers` with plain HTTP addresses
  - `PluginConfig.test_mode` removed — no longer needed
  - `Identity.cgaIpv6` and `Identity.yggIpv6` removed from the type
  - `BootstrapNode.yggAddr` replaced with `addr` (plain hostname or IP)
  - `isYggdrasilAddr()` removed from `peer-server`
  - `DEFAULT_BOOTSTRAP_PEERS` is now empty — bootstrap addresses will be added to `docs/bootstrap.json` once AWS nodes are configured with public HTTP endpoints
  - `startup_delay_ms` default reduced from 30s to 5s
  - `yggdrasil_check` agent tool removed
  - `openclaw p2p setup` CLI command removed

- f11a846: Add pixel playground web frontend (web/index.html, client.js, style.css) — zero-dependency browser UI for the DAP Agent playground
- dabed97: Add standalone World Agent server (world/server.mjs) — deployable by anyone to host a world on the DAP network
- 199404a: Add MAX_AGENTS, WORLD_PUBLIC, WORLD_PASSWORD environment variables to World Agent for capacity limits, private worlds, and password protection

### Patch Changes

- f1ba31b: Configure public HTTP addresses for all 5 AWS bootstrap nodes
- dcd4f1c: Upgrade bootstrap.json format to include transport endpoint fields (quicAddr, udpPort, httpPort) for future multi-transport bootstrap support
- dcd4f1c: Expose did:key (W3C DID) in identity CLI output and agent tool response
- 48042ad: Add TTL-based peer expiry to Gateway and World Agent, active world reachability probing, and PUBLIC_PORT env var support
- 6601249: Gateway probe rejects endpoints that return no worldId (e.g. Gateway's own peer listener on same port)
- e05b197: fix: sync agent-world-sdk version with root package in release workflow
- dcd4f1c: Add TOFU binding TTL (default 7 days) to limit key compromise exposure window

## 0.3.2

### Patch Changes

- 33886e6: Fix clawhub publish by patching acceptLicenseTerms into publish payload

## 0.3.1

### Patch Changes

- 27b252d: Fix clawhub publish in release workflow by passing explicit --version flag

## 0.3.0

### Minor Changes

- c9d5621: BREAKING CHANGE: Peer identity migrated from Yggdrasil IPv6 address (`yggAddr`) to `agentId` (`sha256(publicKey)[:32]`). All v1 protocol compatibility removed — existing peer databases will not migrate.

  - Transport abstraction layer with TransportManager for automatic selection
  - YggdrasilTransport wrapper and UDPTransport (plain UDP with STUN NAT traversal)
  - Multi-transport endpoint support in peer discovery and messaging
  - `agentId` as primary peer identity with `did:key` derivation for W3C compatibility
  - Application-layer Ed25519 signatures + TOFU binding as transport-agnostic trust anchor

All notable changes to this project will be documented in this file.

## [0.2.3] - 2026-03-04

### Added

- Bootstrap nodes now run an always-on AI agent (`/peer/message` endpoint). New users can send messages to any bootstrap node and receive AI-powered replies, solving the cold-start problem when no real peers are online.
- Per-sender rate limiting on bootstrap nodes (default: 10 messages/hour, configurable via `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS`). Rate-limited requests return HTTP 429 with `Retry-After` header.
- Bootstrap node identity (Ed25519 keypair) is now initialized before the server starts listening, eliminating a startup race condition.
- Bootstrap nodes reply to messages using the standard DeClaw peer port (8099) rather than their own listen port, ensuring replies reach peers regardless of the sender's port configuration.

## [0.2.2] - 2026-03-04

### Added

- Agent metadata exchange: peers now share `agent_name` and plugin `version` during `/peer/announce`.
- New `agent_name` config option in plugin settings (falls back to `identity.name` from `openclaw.json`).
- `/peer/announce` response includes `self` metadata so callers learn the responder's name and version on first contact.
- Startup and first-run prompts to set `agent_name` if not configured.
- Bootstrap nodes now advertise `"ReScience Lab's bootstrap-<addr>"` as their name and include version.

### Changed

- `upsertDiscoveredPeer` refreshes `alias` on non-manual peers (stale name fix).
- `listPeers()` return type widened to `DiscoveredPeerRecord[]` for version access.
- CLI `p2p peers` and tools now display peer name and version: `200:abc... — Alice's coder [v0.2.1]`.
- Bootstrap server upgraded to Fastify 5.7.4 across all 5 AWS regions.

## [0.2.1] - 2026-03-03

### Added

- Auto-detect Yggdrasil for `test_mode`: tri-state `"auto"` (default) detects external daemon automatically.
- Auto-inject public peers into system Yggdrasil when only LAN/multicast peers are present.
- Enriched `yggdrasil_check` tool with peer count and routing table size.
- Factory hooks for session management and command safety checks.
- `AGENTS.md` for AI coding agent context, including release process documentation.
- `CHANGELOG.md` for tracking project changes.

### Changed

- Parallelized bootstrap node connections (worst-case 150s → 30s).
- Debounced peer-db disk writes during discovery (1s coalescing).
- Added `os` and `requires.bins` to skill frontmatter for ClawHub security scan.

### Fixed

- Omit `undefined` alias field from announce payload to prevent canonicalization mismatches.

## [0.2.0] - 2026-03-03

### Breaking Changes

- Renamed channel ID from `ipv6-p2p` to `declaw`.
- Renamed service ID from `ipv6-p2p-node` to `declaw-node`.
- Default data directory changed from `~/.openclaw/ipv6-p2p` to `~/.openclaw/declaw`.
- Old `ipv6-p2p` name preserved as a channel alias for backward compatibility.

### Changed

- Merged `ipv6-p2p` and `yggdrasil` skills into a single `declaw` skill.
- Channel label changed from "IPv6 P2P" to "DeClaw".

### Added

- Complete skill documentation: all tool parameters, error handling table, inbound message flow explanation.
- `references/discovery.md` — bootstrap + gossip architecture and trust model.
- Troubleshooting section for `derived_only` state (PATH, permissions, Docker `NET_ADMIN`).
- Eight example interaction flows including diagnostics, non-default port, and first-time user.

## [0.1.2] - 2026-03-03

### Fixed

- Upgraded main plugin Fastify from 4.x to 5.7.4, resolving high-severity vulnerabilities.
- Upgraded bootstrap service Fastify from `^4.26.2` to `^5.0.0` (resolves to 5.7.4).
- Added `bootstrap/package-lock.json` for reproducible installs.
- Fixed recursive key sorting in signature canonicalization (`identity.ts`).
- Fixed `isYggdrasilAddr` regex to correctly match compressed IPv6 addresses like `200:` and `202:` (`peer-server.ts`).
- Clear startup discovery timer on service stop to prevent dangling callbacks (`index.ts`).

### Added

- Periodic sibling sync between bootstrap nodes (5-minute interval).

## [0.1.1] - 2026-03-03

### Fixed

- Aligned plugin ID in `openclaw.plugin.json` to match npm package name.
- Signature verification mismatch between announce and message endpoints.
- Corrected Yggdrasil address regex and added startup delay for route convergence.
- Increased peer exchange timeout from 10s to 30s.

### Added

- DHT-style peer discovery via bootstrap + gossip exchange.
- Standalone bootstrap server with 5 nodes across AWS regions (us-east-2, us-west-2, eu-west-1, ap-northeast-1, ap-southeast-1).
- Fetch bootstrap node list from GitHub Pages (`bootstrap.json`), with hardcoded fallback.
- ClawHub-compatible frontmatter to skills.
- GitHub Actions workflow to publish to npm on release.
- Banner and logo assets.

### Changed

- Renamed project from `claw-p2p` to `DeClaw`.

## [0.1.0] - 2026-03-02

### Added

- Initial release.
- OpenClaw plugin with Ed25519 identity, TOFU peer trust, and Yggdrasil integration.
- Agent tools: `p2p_add_peer`, `p2p_send_message`, `p2p_list_peers`, `p2p_status`, `p2p_discover`, `yggdrasil_check`.
- IPv6 P2P channel registration for OpenClaw chat UI.
- Yggdrasil setup skill with platform-specific install guide.
- Docker P2P test environment.
