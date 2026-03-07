/**
 * P2P client — sends messages to other OpenClaw nodes.
 *
 * Supports multiple delivery strategies:
 *   1. HTTP over Yggdrasil IPv6 (default, existing behavior)
 *   2. QUIC/UDP transport (when TransportManager provides a QUIC transport)
 *   3. HTTP over any reachable IPv4/IPv6 (for non-Yggdrasil peers)
 */
import { P2PMessage, Identity, PeerEndpoint } from "./types";
import { signMessage } from "./identity";
import { Transport } from "./transport";

/**
 * Build a signed P2PMessage payload.
 */
function buildSignedMessage(
  identity: Identity,
  event: string,
  content: string,
): P2PMessage {
  const timestamp = Date.now()
  const payload: Omit<P2PMessage, "signature"> = {
    fromYgg: identity.yggIpv6,
    publicKey: identity.publicKey,
    event,
    content,
    timestamp,
  }
  const signature = signMessage(identity.privateKey, payload as Record<string, unknown>)
  return { ...payload, signature }
}

/**
 * Send a signed message via HTTP POST to a peer's /peer/message endpoint.
 */
async function sendViaHttp(
  msg: P2PMessage,
  targetAddr: string,
  port: number,
  timeoutMs: number,
): Promise<{ ok: boolean; error?: string }> {
  // Determine URL format: bracketed IPv6 vs plain IPv4/hostname
  const isIpv6 = targetAddr.includes(":")
  const url = isIpv6
    ? `http://[${targetAddr}]:${port}/peer/message`
    : `http://${targetAddr}:${port}/peer/message`

  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg),
      signal: ctrl.signal,
    })

    clearTimeout(timer)

    if (!resp.ok) {
      const body = await resp.text().catch(() => "")
      return { ok: false, error: `HTTP ${resp.status}: ${body}` }
    }
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message ?? String(err) }
  }
}

/**
 * Send a signed message via a QUIC/UDP transport.
 */
async function sendViaTransport(
  msg: P2PMessage,
  target: string,
  transport: Transport,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const data = Buffer.from(JSON.stringify(msg))
    await transport.send(target, data)
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message ?? String(err) }
  }
}

export interface SendOptions {
  /** Peer's known transport endpoints (from PeerRecord). */
  endpoints?: PeerEndpoint[]
  /** Available QUIC transport for UDP delivery. */
  quicTransport?: Transport
}

/**
 * Build a signed P2PMessage and deliver it to the target peer.
 *
 * Delivery strategy:
 *   1. If peer has QUIC endpoints and we have a QUIC transport → send via UDP
 *   2. Otherwise → send via HTTP (Yggdrasil IPv6 or direct IPv4/IPv6)
 */
export async function sendP2PMessage(
  identity: Identity,
  yggAddr: string,
  event: string,
  content: string,
  port: number = 8099,
  timeoutMs: number = 10_000,
  opts?: SendOptions,
): Promise<{ ok: boolean; error?: string }> {
  const msg = buildSignedMessage(identity, event, content)

  // Try QUIC transport if peer has a QUIC endpoint and we have the transport
  if (opts?.quicTransport?.isActive() && opts?.endpoints?.length) {
    const quicEndpoint = opts.endpoints
      .filter((e) => e.transport === "quic")
      .sort((a, b) => a.priority - b.priority)[0]
    if (quicEndpoint) {
      const result = await sendViaTransport(msg, quicEndpoint.address, opts.quicTransport)
      if (result.ok) return result
      // Fall through to HTTP on failure
      console.warn(`[p2p:client] QUIC send to ${quicEndpoint.address} failed, falling back to HTTP`)
    }
  }

  // Default: HTTP delivery
  return sendViaHttp(msg, yggAddr, port, timeoutMs)
}

/**
 * Broadcast a signed "leave" tombstone to all known peers on graceful shutdown.
 * Fire-and-forget with a short timeout — best effort.
 */
export async function broadcastLeave(
  identity: Identity,
  peers: Array<{ yggAddr: string; endpoints?: PeerEndpoint[] }>,
  port: number = 8099,
  opts?: SendOptions,
): Promise<void> {
  if (peers.length === 0) return;
  await Promise.allSettled(
    peers.map((p) => sendP2PMessage(identity, p.yggAddr, "leave", "", port, 3_000, {
      ...opts,
      endpoints: p.endpoints ?? opts?.endpoints,
    }))
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
  const isIpv6 = yggAddr.includes(":")
  const url = isIpv6
    ? `http://[${yggAddr}]:${port}/peer/ping`
    : `http://${yggAddr}:${port}/peer/ping`
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
