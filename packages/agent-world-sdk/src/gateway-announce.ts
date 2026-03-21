import {
  canonicalize,
  signHttpRequest,
  DOMAIN_SEPARATORS,
  signWithDomainSeparator,
} from "./crypto.js";
import type { Identity } from "./types.js";
import type { PeerDb } from "./peer-db.js";

const DEFAULT_GATEWAY_URL = "http://localhost:8099";

export interface AnnounceOpts {
  identity: Identity;
  alias: string;
  version?: string;
  publicAddr: string | null;
  publicPort: number;
  capabilities: string[];
  peerDb: PeerDb;
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
    peerDb,
  } = opts;

  const url = `${gatewayUrl.replace(/\/+$/, "")}/peer/announce`;

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
      peers?: Array<{
        agentId: string;
        publicKey: string;
        alias: string;
        endpoints: [];
        capabilities: [];
        lastSeen: number;
      }>;
    };
    for (const peer of data.peers ?? []) {
      if (peer.agentId && peer.agentId !== identity.agentId) {
        peerDb.upsert(peer.agentId, peer.publicKey, {
          alias: peer.alias,
          endpoints: peer.endpoints,
          capabilities: peer.capabilities,
          lastSeen: peer.lastSeen,
        });
      }
    }
  } catch {
    // gateway unreachable — skip silently
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
    onDiscovery?.(opts.peerDb.size);
  }

  let startupTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    startupTimer = undefined;
    void runAnnounce();
  }, 3_000);
  const timer = setInterval(runAnnounce, intervalMs);
  return () => {
    if (startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = undefined;
    }
    clearInterval(timer);
  };
}
