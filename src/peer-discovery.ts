/**
 * DHT-style peer discovery via Bootstrap + Gossip exchange.
 *
 * Flow:
 *   1. On startup, connect to bootstrap nodes (hardcoded + config)
 *   2. POST /peer/announce to each bootstrap → receive their peer list
 *   3. Add discovered peers to local store
 *   4. Fanout: also announce to the peers we just learned about (1 level deep)
 *   5. Periodic loop: re-announce to a sample of known peers to keep the table fresh
 *
 * Any node that runs this plugin becomes a relay — it shares its peer table
 * with anyone who announces to it, so the network self-heals over time.
 */

import { Identity, PeerAnnouncement } from "./types";
import { signMessage } from "./identity";
import { listPeers, upsertDiscoveredPeer, getPeersForExchange, pruneStale } from "./peer-db";

const BOOTSTRAP_JSON_URL =
  "https://resciencelab.github.io/DeClaw/bootstrap.json";

/** Fetch bootstrap node list from the published GitHub Pages JSON. */
export async function fetchRemoteBootstrapPeers(): Promise<string[]> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const resp = await fetch(BOOTSTRAP_JSON_URL, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) return [];
    const data = (await resp.json()) as {
      bootstrap_nodes?: { yggAddr: string; port?: number }[];
    };
    return (data.bootstrap_nodes ?? []).map((n) => n.yggAddr);
  } catch {
    console.warn("[p2p:discovery] Could not fetch remote bootstrap list — using hardcoded fallback");
    return [];
  }
}

/**
 * Hardcoded fallback used only when the remote list is unreachable.
 * Update docs/bootstrap.json instead of editing this array.
 */
export const DEFAULT_BOOTSTRAP_PEERS: string[] = [
  "200:697f:bda:1e8e:706a:6c5e:630b:51d",  // us-east-2
  "200:e1a5:b063:958:8f74:ec45:8eb0:e30e",  // us-west-2
  "200:9cf6:eaf1:7d3e:14b0:5869:2140:b618", // eu-west-1
  "202:adbc:dde1:e272:1cdb:97d0:8756:4f77", // ap-northeast-1
  "200:5ec6:62dd:9e91:3752:820c:98f5:5863", // ap-southeast-1
];

const EXCHANGE_TIMEOUT_MS = 30_000;
const MAX_FANOUT_PEERS = 5;   // how many newly-discovered peers to also announce to
const MAX_SHARED_PEERS = 20;  // max peers we share in one exchange

let _discoveryTimer: NodeJS.Timeout | null = null;

// ── Signed announcement builder ───────────────────────────────────────────────

function buildAnnouncement(identity: Identity): Omit<PeerAnnouncement, "signature"> {
  const myPeers = getPeersForExchange(MAX_SHARED_PEERS).map((p) => {
    const entry: { yggAddr: string; publicKey: string; alias?: string; lastSeen: number } = {
      yggAddr: p.yggAddr,
      publicKey: p.publicKey,
      lastSeen: p.lastSeen,
    };
    if (p.alias) entry.alias = p.alias;
    return entry;
  });

  const ann: Omit<PeerAnnouncement, "signature"> = {
    fromYgg: identity.yggIpv6,
    publicKey: identity.publicKey,
    timestamp: Date.now(),
    peers: myPeers,
  };
  return ann;
}

// ── Core exchange ─────────────────────────────────────────────────────────────

/**
 * POST /peer/announce to a single target node.
 * Returns the list of peers they shared back, or null on failure.
 */
export async function announceToNode(
  identity: Identity,
  targetYggAddr: string,
  port: number = 8099
): Promise<Array<{ yggAddr: string; publicKey: string; alias?: string; lastSeen: number }> | null> {
  const payload = buildAnnouncement(identity);
  const signature = signMessage(identity.privateKey, payload as Record<string, unknown>);
  const announcement: PeerAnnouncement = { ...payload, signature };

  const url = `http://[${targetYggAddr}]:${port}/peer/announce`;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), EXCHANGE_TIMEOUT_MS);

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(announcement),
      signal: ctrl.signal,
    });

    clearTimeout(timer);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.warn(`[p2p:discovery] Announce to ${targetYggAddr.slice(0,20)}... rejected ${resp.status}: ${errText}`);
      return null;
    }

    const body = await resp.json() as { ok: boolean; peers?: any[] };
    return body.peers ?? null;
  } catch (err: any) {
    console.warn(`[p2p:discovery] Announce to ${targetYggAddr.slice(0,20)}... error: ${err?.message}`);
    return null;
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

/**
 * Announce to all bootstrap nodes and absorb their peer tables.
 * Then fanout to a sample of newly-discovered peers.
 */
export async function bootstrapDiscovery(
  identity: Identity,
  port: number = 8099,
  extraBootstrap: string[] = []
): Promise<number> {
  const remotePeers = await fetchRemoteBootstrapPeers();
  const bootstrapAddrs = [
    ...new Set([...remotePeers, ...DEFAULT_BOOTSTRAP_PEERS, ...extraBootstrap]),
  ].filter((a) => a && a !== identity.yggIpv6);

  if (bootstrapAddrs.length === 0) {
    console.log("[p2p:discovery] No bootstrap nodes configured — skipping initial discovery.");
    return 0;
  }

  console.log(`[p2p:discovery] Bootstrapping via ${bootstrapAddrs.length} node(s) (parallel)...`);

  let totalDiscovered = 0;
  const fanoutCandidates: string[] = [];

  const results = await Promise.allSettled(
    bootstrapAddrs.map(async (addr) => {
      const peers = await announceToNode(identity, addr, port);
      return { addr, peers };
    })
  );

  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const { addr, peers } = result.value;
    if (!peers) {
      console.warn(`[p2p:discovery] Bootstrap ${addr.slice(0, 20)}... unreachable`);
      continue;
    }

    for (const p of peers) {
      if (p.yggAddr === identity.yggIpv6) continue;
      upsertDiscoveredPeer(p.yggAddr, p.publicKey, {
        alias: p.alias,
        discoveredVia: addr,
        source: "bootstrap",
        lastSeen: p.lastSeen,
      });
      fanoutCandidates.push(p.yggAddr);
      totalDiscovered++;
    }

    console.log(`[p2p:discovery] Bootstrap ${addr.slice(0, 20)}... → +${peers.length} peers`);
  }

  // Fanout: announce to a sample of newly-learned peers so they know about us too
  const fanout = fanoutCandidates.slice(0, MAX_FANOUT_PEERS);
  await Promise.allSettled(
    fanout.map((addr) =>
      announceToNode(identity, addr, port).then((peers) => {
        if (!peers) return;
        for (const p of peers) {
          if (p.yggAddr === identity.yggIpv6) continue;
          upsertDiscoveredPeer(p.yggAddr, p.publicKey, {
            alias: p.alias,
            discoveredVia: addr,
            source: "gossip",
            lastSeen: p.lastSeen,
          });
        }
      })
    )
  );

  console.log(`[p2p:discovery] Bootstrap complete — ${totalDiscovered} peers discovered`);
  return totalDiscovered;
}

// ── Periodic gossip loop ──────────────────────────────────────────────────────

/**
 * Periodically re-announce to a random sample of known peers to keep the
 * routing table fresh and propagate new nodes across the network.
 */
export function startDiscoveryLoop(
  identity: Identity,
  port: number = 8099,
  intervalMs: number = 10 * 60 * 1000,  // default: every 10 minutes
  extraBootstrap: string[] = []
): void {
  if (_discoveryTimer) return;

  // Protect both hardcoded and dynamically-configured bootstrap addresses from pruning
  const protectedAddrs = [...new Set([...DEFAULT_BOOTSTRAP_PEERS, ...extraBootstrap])];

  const runGossip = async () => {
    // Prune stale peers before gossiping (TTL = 3× interval)
    pruneStale(3 * intervalMs, protectedAddrs);

    const peers = listPeers();
    if (peers.length === 0) return;

    // Pick a random sample to exchange with
    const sample = peers
      .sort(() => Math.random() - 0.5)
      .slice(0, MAX_FANOUT_PEERS);

    let updated = 0;
    await Promise.allSettled(
      sample.map(async (peer) => {
        const received = await announceToNode(identity, peer.yggAddr, port);
        if (!received) return;
        // Direct contact succeeded — update lastSeen to now (omit lastSeen in opts)
        upsertDiscoveredPeer(peer.yggAddr, peer.publicKey, {
          alias: peer.alias,
          discoveredVia: peer.yggAddr,
          source: "gossip",
        });
        for (const p of received) {
          if (p.yggAddr === identity.yggIpv6) continue;
          // Indirect peers: preserve their original timestamp
          upsertDiscoveredPeer(p.yggAddr, p.publicKey, {
            alias: p.alias,
            discoveredVia: peer.yggAddr,
            source: "gossip",
            lastSeen: p.lastSeen,
          });
          updated++;
        }
      })
    );

    if (updated > 0) {
      console.log(`[p2p:discovery] Gossip round: +${updated} peer updates`);
    }
  };

  _discoveryTimer = setInterval(runGossip, intervalMs);
  console.log(`[p2p:discovery] Gossip loop started (interval: ${intervalMs / 1000}s)`);
}

export function stopDiscoveryLoop(): void {
  if (_discoveryTimer) {
    clearInterval(_discoveryTimer);
    _discoveryTimer = null;
    console.log("[p2p:discovery] Gossip loop stopped");
  }
}
