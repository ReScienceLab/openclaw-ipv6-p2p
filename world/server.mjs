/**
 * DAP World Agent — standalone deployable world server.
 * No OpenClaw dependency. Runs on plain HTTP/TCP.
 *
 * Endpoints (provided by agent-world-sdk):
 *   GET  /peer/ping        — health check
 *   GET  /peer/peers       — known DAP peers
 *   POST /peer/announce    — accept signed peer announcement
 *   POST /peer/message     — receive world.join / world.action / world.leave
 *   GET  /world/state      — current world snapshot (HTTP poll)
 *
 * Env:
 *   WORLD_ID      — unique world identifier, e.g. "pixel-city" (required)
 *   WORLD_NAME    — human-readable name, e.g. "Pixel City"
 *   WORLD_THEME   — theme tag, e.g. "city" | "dungeon" | "space"
 *   PEER_PORT     — DAP HTTP port (default 8099)
 *   PUBLIC_PORT   — externally reachable port for DAP announce (default PEER_PORT)
 *   DATA_DIR      — persistence directory (default /data)
 *   BOOTSTRAP_URL — URL of bootstrap.json (default GitHub Pages)
 *   BROADCAST_INTERVAL_MS — how often to broadcast world.state (default 5000)
 *   MAX_AGENTS    — max agents allowed in world (default 0 = unlimited)
 *   WORLD_PUBLIC  — whether to announce to DAP network (default "true")
 *   WORLD_PASSWORD — password required to join (default "" = no password)
 */
import { createWorldServer } from "@resciencelab/agent-world-sdk"

const WORLD_ID = process.env.WORLD_ID
if (!WORLD_ID) { console.error("[world] WORLD_ID env var is required"); process.exit(1) }

const PORT = parseInt(process.env.PEER_PORT ?? "8099")
const PUBLIC_PORT = parseInt(process.env.PUBLIC_PORT ?? String(PORT))
const WORLD_WIDTH = 32
const WORLD_HEIGHT = 32

// ---------------------------------------------------------------------------
// World state
// ---------------------------------------------------------------------------

// agents in world: agentId -> { agentId, alias, x, y, joinedAt, lastSeen }
const worldAgents = new Map()

const events = []
const MAX_EVENTS = 100

function addEvent(type, data) {
  const ev = { type, ...data, ts: Date.now() }
  events.push(ev)
  if (events.length > MAX_EVENTS) events.shift()
  return ev
}

function randomPos() {
  return {
    x: Math.floor(Math.random() * WORLD_WIDTH),
    y: Math.floor(Math.random() * WORLD_HEIGHT),
  }
}

function getWorldSnapshot() {
  return {
    worldId: WORLD_ID,
    worldName: process.env.WORLD_NAME ?? `World (${WORLD_ID})`,
    theme: process.env.WORLD_THEME ?? "default",
    agentCount: worldAgents.size,
    agents: [...worldAgents.values()],
    recentEvents: events.slice(-20),
    ts: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

const server = await createWorldServer(
  {
    worldId: WORLD_ID,
    worldName: process.env.WORLD_NAME ?? `World (${WORLD_ID})`,
    worldTheme: process.env.WORLD_THEME ?? "default",
    port: PORT,
    publicPort: PUBLIC_PORT,
    publicAddr: process.env.PUBLIC_ADDR ?? null,
    dataDir: process.env.DATA_DIR ?? "/data",
    bootstrapUrl: process.env.BOOTSTRAP_URL,
    maxAgents: parseInt(process.env.MAX_AGENTS ?? "0"),
    isPublic: (process.env.WORLD_PUBLIC ?? "true") === "true",
    password: process.env.WORLD_PASSWORD ?? "",
    broadcastIntervalMs: parseInt(process.env.BROADCAST_INTERVAL_MS ?? "5000"),
    setupRoutes(fastify) {
      fastify.get("/world/state", async () => getWorldSnapshot())
    },
  },
  {
    async onJoin(agentId, data) {
      const pos = randomPos()
      const alias = data.alias ?? data.agentId ?? agentId.slice(0, 8)
      worldAgents.set(agentId, {
        agentId, alias,
        x: pos.x, y: pos.y,
        joinedAt: Date.now(), lastSeen: Date.now(),
      })
      addEvent("join", { agentId, alias, worldId: WORLD_ID })
      return {
        manifest: {
          name: process.env.WORLD_NAME ?? `World (${WORLD_ID})`,
          theme: process.env.WORLD_THEME ?? "default",
          description: `A world on a ${WORLD_WIDTH}x${WORLD_HEIGHT} grid.`,
          objective: "Explore the world and interact with other agents.",
          rules: [
            `The world is a ${WORLD_WIDTH}x${WORLD_HEIGHT} grid.`,
            "Agents can move to any tile by sending a move action with x,y coordinates.",
            "Idle agents are evicted after 5 minutes.",
          ],
          actions: {
            move: {
              params: { x: `0-${WORLD_WIDTH - 1}`, y: `0-${WORLD_HEIGHT - 1}` },
              desc: "Move to position (x, y) on the grid.",
            },
          },
          state_fields: [
            "agentId — your agent identifier",
            "x — current x position on the grid",
            "y — current y position on the grid",
            "alias — your display name",
          ],
        },
        state: { agentId, pos },
      }
    },

    async onAction(agentId, data) {
      const agent = worldAgents.get(agentId)
      if (!agent) return { ok: false }
      agent.lastSeen = Date.now()
      if (data.action === "move" && data.x != null && data.y != null) {
        agent.x = Math.max(0, Math.min(WORLD_WIDTH - 1, Math.floor(data.x)))
        agent.y = Math.max(0, Math.min(WORLD_HEIGHT - 1, Math.floor(data.y)))
      }
      addEvent("action", { agentId, alias: agent.alias, action: data.action, payload: data, worldId: WORLD_ID })
      return { ok: true }
    },

    async onLeave(agentId) {
      const agent = worldAgents.get(agentId)
      if (agent) {
        worldAgents.delete(agentId)
        addEvent("leave", { agentId, alias: agent.alias, worldId: WORLD_ID })
      }
    },

    getState() {
      return getWorldSnapshot()
    },
  }
)
