import Fastify from "fastify";
import { loadOrCreateIdentity } from "./identity.js";
import { PeerDb } from "./peer-db.js";
import { registerPeerRoutes } from "./peer-protocol.js";
import { startDiscovery } from "./bootstrap.js";
import {
  canonicalize,
  signPayload,
  signHttpRequest,
  DOMAIN_SEPARATORS,
  signWithDomainSeparator,
} from "./crypto.js";
import { WorldLedger } from "./world-ledger.js";
import type {
  WorldConfig,
  WorldHooks,
  WorldServer,
  WorldManifest,
  LedgerQueryOpts,
} from "./types.js";

const DEFAULT_BOOTSTRAP_URL =
  "https://resciencelab.github.io/DAP/bootstrap.json";

/**
 * Start a fully-wired DAP World Agent server.
 *
 * Handles: identity, peer DB, bootstrap discovery, peer protocol routes,
 * world.join / world.action / world.leave dispatch, idle-agent eviction,
 * and periodic world.state broadcasts.
 *
 * @param config  World configuration (see WorldConfig)
 * @param hooks   Game logic callbacks (see WorldHooks)
 * @returns       WorldServer with `.fastify` for additional route registration
 */
export async function createWorldServer(
  config: WorldConfig,
  hooks: WorldHooks
): Promise<WorldServer> {
  const {
    worldId,
    worldName = `World (${worldId})`,
    worldTheme = "default",
    worldType = "programmatic",
    hostAgentId,
    hostCardUrl,
    hostEndpoints,
    port = 8099,
    publicPort,
    publicAddr = null,
    dataDir = "/data",
    bootstrapUrl = DEFAULT_BOOTSTRAP_URL,
    maxAgents = 0,
    isPublic = true,
    password = "",
    broadcastIntervalMs = 5_000,
    discoveryIntervalMs = 10 * 60 * 1000,
    staleTtlMs = 30 * 60 * 1000,
    setupRoutes,
    cardUrl,
    cardName,
    cardDescription,
  } = config;

  function buildManifest(manifest?: WorldManifest): WorldManifest {
    const result: WorldManifest = {
      name: manifest?.name ?? worldName,
      ...manifest,
      type: manifest?.type ?? worldType ?? "programmatic",
      theme: manifest?.theme ?? worldTheme,
    };

    if (result.type === "hosted" && hostAgentId) {
      result.host = {
        agentId: hostAgentId,
        cardUrl: hostCardUrl,
        endpoints: hostEndpoints,
        ...result.host,
      };
    }

    return result;
  }

  const resolvedPublicPort = publicPort ?? port;

  const identity = loadOrCreateIdentity(dataDir, "world-identity");
  console.log(
    `[world] agentId=${identity.agentId} world=${worldId} name="${worldName}"`
  );

  const peerDb = new PeerDb({ staleTtlMs });

  // Track agents currently in world for idle eviction
  const agentLastSeen = new Map<string, number>();

  // Append-only event ledger — blockchain-inspired agent activity log
  const ledger = new WorldLedger(dataDir, worldId, identity);
  console.log(
    `[world] Ledger loaded — ${ledger.length} entries, head=${ledger.head?.hash.slice(0, 8) ?? "none"}`
  );

  const fastify = Fastify({ logger: false });

  // Register peer protocol routes
  registerPeerRoutes(fastify, {
    identity,
    peerDb,
    card: cardUrl
      ? { name: cardName ?? worldName, description: cardDescription, cardUrl }
      : undefined,
    pingExtra: () => ({
      worldId,
      worldName,
      agents: agentLastSeen.size,
      ...(maxAgents ? { maxAgents } : {}),
      isPublic,
      passwordRequired: password.length > 0,
    }),
    onMessage: async (agentId, event, content, sendReply) => {
      const data = (content ?? {}) as Record<string, unknown>;

      switch (event) {
        case "world.join": {
          if (maxAgents > 0 && agentLastSeen.size >= maxAgents) {
            sendReply(
              { error: `World is full (${maxAgents}/${maxAgents} agents)` },
              403
            );
            return;
          }
          if (password && data["password"] !== password) {
            sendReply({ error: "Invalid password" }, 403);
            return;
          }
          agentLastSeen.set(agentId, Date.now());
          const result = await hooks.onJoin(agentId, data);
          ledger.append("world.join", agentId, (data["alias"] ?? data["name"]) as string | undefined);
          sendReply({
            ok: true,
            worldId,
            manifest: buildManifest(result.manifest),
            state: result.state,
          });
          console.log(
            `[world] ${agentId.slice(0, 8)} joined — ${
              agentLastSeen.size
            } agents`
          );
          return;
        }

        case "world.leave": {
          const wasPresent = agentLastSeen.has(agentId);
          agentLastSeen.delete(agentId);
          if (wasPresent) {
            await hooks.onLeave(agentId);
            ledger.append("world.leave", agentId);
            console.log(
              `[world] ${agentId.slice(0, 8)} left — ${
                agentLastSeen.size
              } agents`
            );
          }
          sendReply({ ok: true });
          return;
        }

        case "world.action": {
          if (!agentLastSeen.has(agentId)) {
            sendReply({ error: "Agent not in world — join first" }, 400);
            return;
          }
          agentLastSeen.set(agentId, Date.now());
          const { ok, state } = await hooks.onAction(agentId, data);
          ledger.append("world.action", agentId, undefined, { action: data["action"] as string | undefined });
          sendReply({ ok, state });
          return;
        }

        default:
          sendReply({ ok: true });
      }
    },
  });

  // World ledger HTTP endpoints
  fastify.get("/world/ledger", async (req) => {
    const query = req.query as Record<string, string>;
    const opts: LedgerQueryOpts = {};
    if (query.agent_id) opts.agentId = query.agent_id;
    if (query.event) opts.event = query.event.split(",") as LedgerQueryOpts["event"];
    if (query.since) opts.since = parseInt(query.since);
    if (query.until) opts.until = parseInt(query.until);
    if (query.limit) opts.limit = parseInt(query.limit);
    return {
      ok: true,
      worldId,
      chainHead: ledger.head?.hash ?? null,
      total: ledger.length,
      entries: ledger.getEntries(opts),
    };
  });

  fastify.get("/world/agents", async () => {
    return {
      ok: true,
      worldId,
      agents: ledger.getAgentSummaries(new Set(agentLastSeen.keys())),
    };
  });

  // Allow caller to register additional routes before listen
  if (setupRoutes) await setupRoutes(fastify);

  await fastify.listen({ port, host: "::" });
  console.log(`[world] Listening on [::]:${port}  world=${worldId}`);

  // Outbound: broadcast world.state to known peers
  async function broadcastWorldState() {
    const state = hooks.getState();
    const snapshot = {
      worldId,
      worldName,
      theme: worldTheme,
      ...((state as object) ?? {}),
    };
    const knownPeers = [...peerDb.values()].filter((p) => p.endpoints?.length);
    if (!knownPeers.length) return;

    const payload: Record<string, unknown> = {
      from: identity.agentId,
      publicKey: identity.pubB64,
      event: "world.state",
      content: JSON.stringify(snapshot),
      timestamp: Date.now(),
    };
    payload["signature"] = signWithDomainSeparator(
      DOMAIN_SEPARATORS.WORLD_STATE,
      payload,
      identity.secretKey
    );

    await Promise.allSettled(
      knownPeers.map(async (peer) => {
        for (const ep of [...peer.endpoints].sort(
          (a, b) => a.priority - b.priority
        )) {
          try {
            const isIpv6 =
              ep.address.includes(":") && !ep.address.includes(".");
            const url = isIpv6
              ? `http://[${ep.address}]:${ep.port ?? 8099}/peer/message`
              : `http://${ep.address}:${ep.port ?? 8099}/peer/message`;
            const body = JSON.stringify(canonicalize(payload));
            const urlObj = new URL(url);
            const awHeaders = signHttpRequest(
              identity,
              "POST",
              urlObj.host,
              "/peer/message",
              body
            );
            await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...awHeaders },
              body,
              signal: AbortSignal.timeout(8_000),
            });
            return;
          } catch {
            /* try next endpoint */
          }
        }
      })
    );
  }

  const broadcastTimer = setInterval(broadcastWorldState, broadcastIntervalMs);

  // Idle agent eviction (5 min)
  const evictionTimer = setInterval(async () => {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [id, ts] of agentLastSeen) {
      if (ts < cutoff) {
        agentLastSeen.delete(id);
        await hooks.onLeave(id).catch(() => {});
        ledger.append("world.evict", id, undefined, { reason: "idle" });
        console.log(`[world] ${id.slice(0, 8)} evicted (idle)`);
      }
    }
  }, 60_000);

  // Stale peer pruning
  const pruneTimer = setInterval(() => {
    const pruned = peerDb.prune();
    if (pruned > 0) console.log(`[world] Pruned ${pruned} stale peer(s)`);
  }, 5 * 60 * 1000);

  // Bootstrap discovery
  let stopDiscovery: (() => void) | undefined;
  if (isPublic) {
    stopDiscovery = await startDiscovery({
      identity,
      alias: worldName,
      publicAddr,
      publicPort: resolvedPublicPort,
      capabilities: [`world:${worldId}`],
      peerDb,
      bootstrapUrl,
      intervalMs: discoveryIntervalMs,
      onDiscovery: (n) =>
        console.log(`[world] Discovery complete — ${n} peer(s)`),
    });
    console.log(`[world] Public mode — announcing to DAP network`);
  } else {
    console.log(`[world] Private mode — skipping DAP network announce`);
  }

  return {
    fastify,
    identity,
    ledger,
    async stop() {
      clearInterval(broadcastTimer);
      clearInterval(evictionTimer);
      clearInterval(pruneTimer);
      stopDiscovery?.();
      await fastify.close();
    },
  };
}
