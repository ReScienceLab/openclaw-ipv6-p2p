# AWN (Agent World Network)

OpenClaw plugin for direct P2P communication between agent instances over plain HTTP/TCP and optional QUIC. Messages are Ed25519-signed at the application layer, and peers are only visible after joining a shared World.

## Core Commands

- Build: `npm run build`
- Build SDK for tests that import `packages/agent-world-sdk/dist`: `npm --prefix packages/agent-world-sdk run build`
- Run tests: `node --test test/*.test.mjs`
- Dev (watch mode): `npm run dev`
- Add changeset: `npx changeset add`
- Publish skill to ClawHub: `npx clawhub@latest publish skills/awn`

For full repo validation, build both packages before tests: `npm run build && npm --prefix packages/agent-world-sdk run build && node --test test/*.test.mjs`.

## Project Layout

```
├── src/                        → TypeScript plugin source
│   ├── index.ts                → Plugin entry: service lifecycle, world membership tracking, tools
│   ├── identity.ts             → Ed25519 keypair, agentId derivation, DID key
│   ├── address.ts              → Direct peer address parsing utilities
│   ├── transport.ts            → Transport interface + TransportManager
│   ├── transport-quic.ts       → UDPTransport with ADVERTISE_ADDRESS endpoint config
│   ├── peer-server.ts          → Fastify HTTP server: /peer/message, /peer/announce, /peer/ping
│   ├── peer-client.ts          → Outbound signed message + ping
│   ├── peer-db.ts              → JSON peer store with TOFU and debounced writes
│   ├── channel.ts              → OpenClaw channel registration (inbound/outbound wiring)
│   └── types.ts                → Shared interfaces
├── test/                       → Node.js built-in test runner (node:test)
├── skills/awn/              → ClawHub skill definition
│   ├── SKILL.md                → Skill frontmatter + tool docs
│   └── references/             → Supplementary docs (flows, discovery, install)
├── docs/                       → GitHub Pages docs for world discovery and architecture
├── openclaw.plugin.json        → Plugin manifest (channels, config schema, UI hints)
└── docker/                     → Docker Compose for local multi-node testing
```

## Architecture Overview

Plugin registers a background service (`awn-node`) that:
1. Loads/creates an Ed25519 identity (`~/.openclaw/awn/identity.json`)
2. Starts a Fastify peer server on `[::]:8099`
3. Registers tools (`p2p_status`, `p2p_list_peers`, `p2p_send_message`, `list_worlds`, `join_world`) and the AWN channel
4. Discovers worlds via `list_worlds()` and joins them via `join_world()`
5. World membership provides peer discovery — co-members' endpoints arrive from the world server on join
6. Runs periodic member refresh (30s) to keep world membership current

Trust model (4-layer):
1. Ed25519 signature over canonical JSON (application-layer)
2. TOFU: first message caches public key; subsequent must match
3. agentId derived from public key — unforgeable anchor identity
4. World co-membership — transport rejects senders outside shared worlds

## Development Patterns

### TypeScript
- Strict mode, ES2022 target, CommonJS output
- No semicolons in source (match existing style)
- Tests use `node:test` + `node:assert/strict` (no external test framework)
- Tests import from `dist/` — always `npm run build` first
- World-state broadcast tests can model discovered non-members by sending a signed `/peer/announce` without `world.join`; this populates discovery state without creating active membership.
- To prove broadcast endpoint ownership in `test/world-state-broadcast.test.mjs`, seed a discovered non-member alongside a joined member and assert intercepted `/peer/message` sends hit exactly the joined member's ports.

### Plugin Config
All runtime config is in `openclaw.json` under `plugins.entries.awn.config`:
```json
{
  "peer_port": 8099,
  "quic_port": 8098,
  "advertise_address": "vpn.example.com",
  "advertise_port": 4433,
  "data_dir": "~/.openclaw/awn",
  "tofu_ttl_days": 7,
  "agent_name": "Alice's coder"
}
```

### Gateway World Discovery
- World Servers announce directly to the Gateway via `GATEWAY_URL`
- The Gateway exposes `GET /worlds` for discovery and `GET /world/<worldId>` for endpoint/public-key lookup during `join_world()`
- There is no standalone `bootstrap/` deployment or published `docs/bootstrap.json` artifact in this branch
- Agents still use `list_worlds()` for discovery and `join_world()` for direct membership

### Peer DB
- JSON file at `$data_dir/peers.json`
- World membership / registry writes are debounced (1s); manual ops and TOFU writes are immediate
- `flushDb()` called on service shutdown

### SDK Key Rotation
- In `packages/agent-world-sdk/src/peer-protocol.ts`, the authoritative `/peer/key-rotation` validation lives inside `registerPeerRoutes()`; add binding checks there before the `peerDb.upsert(agentId, newPublicKeyB64, {})` state mutation.
- Reuse `agentIdFromPublicKey()` from `packages/agent-world-sdk/src/crypto.ts` for key-to-agent binding checks instead of duplicating derivation logic in tests or route handlers.
- The root plugin server in `src/peer-server.ts` also implements `/peer/key-rotation` for repo-level tests; when tightening rotation validation in the SDK route, mirror the same binding checks and error contract there so `dist/peer-server.js` stays behaviorally aligned.

### SDK Base58 Codec
- The leading-zero-sensitive Base58 encoder for DID/multibase output lives in `packages/agent-world-sdk/src/identity.ts`, while the matching Base58 decoder used by `multibaseToBase64()` lives in `packages/agent-world-sdk/src/peer-protocol.ts`; codec fixes need both sides kept behaviorally aligned.
- For canonical zero-value boundaries, both codec halves need an explicit all-zero special case: `base58Encode()` must return only the leading `1` prefix run for all-zero byte arrays, and `base58Decode()` must return exactly one zero byte per leading `1` without keeping an extra synthetic accumulator byte.
- For codec regressions, prefer a dedicated root test file that imports built `dist/` artifacts and asserts the canonical boundary cases `[0]`, `[0,0]`, `[0,1]`, `[1]`, and `[1,0]` directly instead of only relying on broader identity or protocol tests.

### SDK World Ledger
- In `packages/agent-world-sdk/src/world-ledger.ts`, keep `LEDGER_SEPARATOR` defined directly as ``AgentWorld-Ledger-${PROTOCOL_VERSION}\0`` by importing `PROTOCOL_VERSION` from `./version.js`; do not derive it indirectly from `DOMAIN_SEPARATORS.MESSAGE`.
- For regressions around private SDK constants like `LEDGER_SEPARATOR`, prefer a root `node:test` file that reads the built `packages/agent-world-sdk/dist` artifact and pairs that with a narrow runtime signature check, rather than exporting the constant only for test access.

### World Server Membership
- In `packages/agent-world-sdk/src/world-server.ts`, joined-world membership is tracked by `agentLastSeen` and `agentEndpoints`; `getMembers()` already treats active members as the intersection of those maps.
- `peerDb` is broader discovery state and may include known peers outside the active world membership, so broadcast recipient selection should not use `peerDb` as the source of truth for world-state delivery.
- In `packages/agent-world-sdk/src/world-server.ts`, once a broadcast recipient is selected, endpoint delivery must also come from that member's `agentEndpoints` entry rather than `peerDb`, so world-state sends cannot reuse unrelated discovered endpoints.
- In `packages/agent-world-sdk/src/world-server.ts`, `broadcastWorldState()` should attempt delivery to every registered endpoint owned by each active member; do not stop after the first successful endpoint because multi-endpoint members expect a send attempt per endpoint.
- In `packages/agent-world-sdk/src/world-server.ts`, outbound `world.state` payloads still travel over the standard `/peer/message` verification path, so their signatures must use `DOMAIN_SEPARATORS.MESSAGE` rather than the separate world-state domain constant.

## Git Workflow

### Branching Strategy

- `main` — The only long-lived branch, always deployable
- `feature/<slug>` — New features (branch from `main`)
- `fix/<slug>` — Bug fixes (branch from `main`)

### Workflow

```bash
# Start any change
git checkout main && git pull
git checkout -b feature/<slug>   # or fix/<slug>

# ... make changes ...
npx changeset add   # select patch/minor/major, write a description

# Push and open PR targeting main
git push -u origin feature/<slug>
gh pr create --base main
```

No `develop` branch. No git-flow. No backmerge.

### Important: All Changes Via PR

**`main` is branch-protected. No direct push allowed.**

1. Push feature/fix branch to origin
2. Create PR targeting `main`
3. CI must pass (`test (20)` + `test (22)`)
4. Squash merge only — one commit per PR
5. **Close the corresponding issue** when merging (use `Fixes #N` or `Closes #N` in the PR description)
6. Merged branches are auto-deleted

### Commit Convention

- `feat:` — New features
- `fix:` — Bug fixes
- `perf:` — Performance improvements
- `refactor:` — Code refactoring
- `docs:` — Documentation changes
- `test:` — Test additions/changes
- `chore:` — Maintenance tasks
- Breaking changes: `feat!:` with `BREAKING CHANGE:` footer (0.x phase — breaking changes expected)

**Do not add any watermark or AI-generated signatures to commit messages.**

### Issue Management

When creating new issues:
1. **Add type labels**: `bug`, `feature`, `enhancement`, `documentation`, `refactor`, `test`, `chore`
2. **Add tag labels**: `priority:high` / `priority:medium` / `priority:low`, `good first issue`, `help wanted`, area tags (`bootstrap`, `p2p`, `identity`, etc.)
3. **Write clear descriptions**: bugs include reproduction steps + expected vs actual; features describe use case and desired outcome

### PR Requirements

1. All tests must pass: `npm run build && node --test test/*.test.mjs`
2. TypeScript must compile: `npm run build`
3. Feature/fix branches merge to `main` via PR
4. Reference the issue number in the PR description (e.g., `#123`)
5. Use closing keywords to auto-close issues on merge (e.g., `Fixes #123`, `Closes #123`)

## Release Process

### How Releases Work (Changesets)

AWN uses [Changesets](https://github.com/changesets/changesets) for automated versioning and publishing. The flow aligns with mastra, langchain, and other major TypeScript projects.

**Step 1 — When opening a PR, add a changeset:**

```bash
npx changeset add
# → select: patch / minor / major
# → write one line describing the change
# → commit the generated .changeset/xxx.md alongside your code
```

**Step 2 — Merge PR to `main`.**

CI (`release.yml`) detects the new changeset and automatically creates or updates a **"Version Packages" PR** that:
- Bumps `package.json`, `openclaw.plugin.json`, `skills/awn/SKILL.md`
- Updates `CHANGELOG.md`

**Step 3 — Merge the "Version Packages" PR.**

CI runs again and automatically:
1. Publishes to npm (`NPM_TOKEN`)
2. Creates GitHub Release + tag
3. Publishes skill to ClawHub (`CLAWHUB_TOKEN`)

No manual version bumping, no release scripts, no backmerge.

### CI Workflows

| Workflow | Trigger | What it does |
|---|---|---|
| `release.yml` | Push to `main` | Changesets: create Version PR or publish npm + GH Release + ClawHub |
| `publish.yml` | `workflow_dispatch` only | Emergency manual npm publish |
| `test.yml` | Push/PR to `main` | Build + test (Node 20+22) |
| `auto-close-issues.yml` | PR merged | Close linked issues |

### Branch Strategy

`main` is the only long-lived branch. All feature/fix branches target `main` directly:

```bash
git checkout -b feature/<slug>     # or fix/<slug>
# ... make changes + npx changeset add ...
git push -u origin feature/<slug>
gh pr create --base main
```

No `develop` branch. No backmerge.

### Branch Protection

`main` is protected:
- **No direct push** — all changes via PR (squash merge only)
- **Required CI**: `test (20)` + `test (22)` must pass
- **No force push** or branch deletion
- **Enforced for admins** — no bypass

### Repo Security

- **Secret scanning + push protection**: enabled (GitHub catches leaked tokens)
- **Squash merge only**: one commit per PR, clean history
- **Auto-delete branches**: merged PR branches are cleaned up automatically
- **Required secrets**: `NPM_TOKEN` (npm), `CLAWHUB_TOKEN` (ClawHub)

### Version-bearing Files

`scripts/sync-version.mjs` (run automatically by `npm run version`) keeps these in sync:

| File | Field |
|---|---|
| `package.json` | `"version"` (canonical source — bumped by Changesets) |
| `package-lock.json` | `"version"` (auto-updated) |
| `openclaw.plugin.json` | `"version"` |
| `skills/awn/SKILL.md` | `version:` in YAML frontmatter |

### Versioning

Semantic versioning: `vMAJOR.MINOR.PATCH`
- MAJOR: Breaking changes (in 0.x phase, MINOR covers breaking changes)
- MINOR: New features
- PATCH: Bug fixes

When adding a changeset, choose accordingly.

### Gateway Discovery Deployment
- This branch no longer ships or deploys a standalone `bootstrap/` service
- If world discovery behavior changes, update the Gateway deployment that serves `GATEWAY_URL`
- Verify discovery with `curl -s "$GATEWAY_URL/worlds"` and, for a specific world, `curl -s "$GATEWAY_URL/world/<worldId>"`
- The published docs page documents those Gateway endpoints directly; there is no `docs/bootstrap.json` mirror to keep in sync

### Version-bearing Files

These files must always have matching versions (synced automatically by `scripts/sync-version.mjs` during `npm run version`):
| File | Field |
|---|---|
| `package.json` | `"version"` (canonical source) |
| `package-lock.json` | `"version"` (auto-updated by `npm version`) |
| `openclaw.plugin.json` | `"version"` |
| `skills/awn/SKILL.md` | `version:` in YAML frontmatter |

### Versioning

Semantic versioning: `vMAJOR.MINOR.PATCH`
- MAJOR: Breaking changes (in 0.x phase, MINOR covers breaking changes)
- MINOR: New features
- PATCH: Bug fixes

## Security

- Ed25519 private keys stored at `~/.openclaw/awn/identity.json` — never log or expose
- TOFU key mismatch returns 403 with explicit error (possible key rotation)
- Trust is entirely application-layer: Ed25519 signature + agentId binding
