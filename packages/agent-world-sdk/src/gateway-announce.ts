import {
  canonicalize,
  signHttpRequest,
  DOMAIN_SEPARATORS,
  signWithDomainSeparator,
} from "./crypto.js";
import type { Identity } from "./types.js";
import type { AgentDb } from "./agent-db.js";

const DEFAULT_GATEWAY_URL = "http://localhost:8100";

export interface AnnounceOpts {
  identity: Identity;
  alias: string;
  version?: string;
  publicAddr: string | null;
  publicPort: number;
  capabilities: string[];
  agentDb: AgentDb;
}

export async function announceToGateway(
  gatewayUrl: string,
  opts: AnnounceOpts
): Promise<void> {
  const {
    identity,
    alias,
    version,
    publicAddr,
    publicPort,
    capabilities,
    agentDb,
  } = opts;

  const url = `${gatewayUrl.replace(/\/+$/, "")}/agents`;

  const endpoints = publicAddr
    ? [
        {
          transport: "tcp",
          address: publicAddr,
          port: publicPort,
          priority: 1,
          ttl: 3600,
        },
      ]
    : [];

  const payload: Record<string, unknown> = {
    from: identity.agentId,
    publicKey: identity.pubB64,
    alias,
    version: version ?? "1.0.0",
    endpoints,
    capabilities,
    timestamp: Date.now(),
  };
  payload["signature"] = signWithDomainSeparator(
    DOMAIN_SEPARATORS.ANNOUNCE,
    payload,
    identity.secretKey
  );

  try {
    const body = JSON.stringify(canonicalize(payload));
    const urlObj = new URL(url);
    const awHeaders = signHttpRequest(
      identity,
      "POST",
      urlObj.host,
      urlObj.pathname,
      body
    );
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...awHeaders },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return;
    const data = (await resp.json()) as {
      agents?: Array<{
        agentId: string;
        publicKey: string;
        alias: string;
        endpoints: [];
        capabilities: [];
        lastSeen: number;
      }>;
    };
    for (const agent of data.agents ?? []) {
      if (agent.agentId && agent.agentId !== identity.agentId) {
        agentDb.upsert(agent.agentId, agent.publicKey, {
          alias: agent.alias,
          endpoints: agent.endpoints,
          capabilities: agent.capabilities,
          lastSeen: agent.lastSeen,
        });
      }
    }
  } catch {
    // gateway unreachable — skip silently
  }
}

/**
 * Send a lightweight heartbeat to a gateway.
 * World servers use POST /worlds/:worldId/heartbeat (signature covers { worldId, ts }).
 * Regular agents use POST /agents/:agentId/heartbeat (signature covers { agentId, ts }).
 * Returns true if the gateway accepted it, false if it responded with
 * 404/403 (unknown or key mismatch — caller should re-announce).
 * Network errors return true (no re-announce needed, gateway is just unreachable).
 */
export async function sendHeartbeat(
  gatewayUrl: string,
  identity: Identity,
  opts: { worldId?: string } = {}
): Promise<boolean> {
  const base = gatewayUrl.replace(/\/+$/, "");
  const ts = Date.now();
  let url: string;
  let signable: Record<string, unknown>;

  if (opts.worldId) {
    url = `${base}/worlds/${encodeURIComponent(opts.worldId)}/heartbeat`;
    signable = { worldId: opts.worldId, ts };
  } else {
    url = `${base}/agents/${encodeURIComponent(identity.agentId)}/heartbeat`;
    signable = { agentId: identity.agentId, ts };
  }

  const signature = signWithDomainSeparator(
    DOMAIN_SEPARATORS.HEARTBEAT,
    signable,
    identity.secretKey
  );
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ts, signature }),
      signal: AbortSignal.timeout(5_000),
    });
    if (resp.status === 404 || resp.status === 403) return false;
    return true;
  } catch {
    // gateway unreachable — skip silently
    return true;
  }
}

export interface GatewayAnnounceOpts extends AnnounceOpts {
  gatewayUrls?: string | string[];
  intervalMs?: number;
  onDiscovery?: (peerCount: number) => void;
}

/**
 * Announce to all gateway URLs once, then schedule repeating announcements.
 * Returns a cleanup function that cancels the interval.
 */
export async function startGatewayAnnounce(opts: GatewayAnnounceOpts): Promise<() => void> {
  const { gatewayUrls, intervalMs = 10 * 60 * 1000, onDiscovery } = opts;

  // Resolve gateway URLs from string, string[], or comma-separated string
  let urls: string[];
  if (Array.isArray(gatewayUrls)) {
    urls = gatewayUrls;
  } else if (typeof gatewayUrls === "string") {
    urls = gatewayUrls.split(",").map((u) => u.trim()).filter(Boolean);
  } else {
    urls = [DEFAULT_GATEWAY_URL];
  }

  async function runAnnounce() {
    await Promise.allSettled(
      urls.map((u) => announceToGateway(u, opts))
    );
    onDiscovery?.(opts.agentDb.size);
  }

  const worldCap = opts.capabilities.find((c) => c.startsWith("world:"));
  const worldId = worldCap ? worldCap.slice("world:".length) : undefined;

  async function runHeartbeat() {
    const results = await Promise.allSettled(
      urls.map(async (u) => ({ url: u, ok: await sendHeartbeat(u, opts.identity, { worldId }) }))
    );
    // Re-announce to any gateway that rejected the heartbeat (404/403)
    const reannounce = results
      .filter((r): r is PromiseFulfilledResult<{ url: string; ok: boolean }> =>
        r.status === "fulfilled" && !r.value.ok)
      .map((r) => announceToGateway(r.value.url, opts));
    if (reannounce.length) await Promise.allSettled(reannounce);
  }

  let startupTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    startupTimer = undefined;
    void runAnnounce();
  }, 3_000);
  const timer = setInterval(runAnnounce, intervalMs);
  const heartbeatTimer = setInterval(runHeartbeat, 30_000);
  return () => {
    if (startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = undefined;
    }
    clearInterval(timer);
    clearInterval(heartbeatTimer);
  };
}
