/**
 * P2P client — sends messages to other OpenClaw nodes via their Yggdrasil address.
 */
import { P2PMessage, Identity } from "./types";
import { signMessage } from "./identity";

/**
 * Build a signed P2PMessage and POST it to the target peer.
 * Target URL: http://[<yggAddr>]:8099/peer/message
 */
export async function sendP2PMessage(
  identity: Identity,
  yggAddr: string,
  event: string,
  content: string,
  port: number = 8099,
  timeoutMs: number = 10_000
): Promise<{ ok: boolean; error?: string }> {
  const timestamp = Date.now();

  const payload: Omit<P2PMessage, "signature"> = {
    fromYgg: identity.yggIpv6,
    publicKey: identity.publicKey,
    event,
    content,
    timestamp,
  };

  const signature = signMessage(identity.privateKey, payload as Record<string, unknown>);
  const msg: P2PMessage = { ...payload, signature };

  const url = `http://[${yggAddr}]:${port}/peer/message`;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg),
      signal: ctrl.signal,
    });

    clearTimeout(timer);

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { ok: false, error: `HTTP ${resp.status}: ${body}` };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message ?? String(err) };
  }
}

/**
 * Broadcast a signed "leave" tombstone to all known peers on graceful shutdown.
 * Fire-and-forget with a short timeout — best effort.
 */
export async function broadcastLeave(
  identity: Identity,
  peers: Array<{ yggAddr: string }>,
  port: number = 8099
): Promise<void> {
  if (peers.length === 0) return;
  await Promise.allSettled(
    peers.map((p) => sendP2PMessage(identity, p.yggAddr, "leave", "", port, 3_000))
  );
  console.log(`[p2p] Leave broadcast sent to ${peers.length} peer(s)`);
}

/**
 * Ping a peer — returns true if reachable within timeout.
 */
export async function pingPeer(
  yggAddr: string,
  port: number = 8099,
  timeoutMs: number = 5_000
): Promise<boolean> {
  const url = `http://[${yggAddr}]:${port}/peer/ping`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const resp = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    return resp.ok;
  } catch {
    return false;
  }
}
