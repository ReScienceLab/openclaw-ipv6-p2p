/**
 * Transport abstraction layer for DeClaw P2P communication.
 *
 * Defines the interface that all transport backends (Yggdrasil, QUIC, native IPv6)
 * must implement, plus the TransportManager that handles automatic selection.
 */
import { Identity, Endpoint } from "./types"

export type TransportId = "yggdrasil" | "quic" | "native-ipv6"

export interface TransportEndpoint {
  transport: TransportId
  address: string    // ygg addr, or host:port for QUIC
  port: number       // listening port
  priority: number   // lower = preferred
  ttl: number        // seconds until re-resolve
}

export interface Transport {
  readonly id: TransportId
  readonly address: string

  /**
   * Initialize and start the transport.
   * Returns true if the transport is available and started successfully.
   */
  start(identity: Identity, opts?: Record<string, unknown>): Promise<boolean>

  /** Gracefully shut down the transport. */
  stop(): Promise<void>

  /** Whether this transport is currently active and can send/receive. */
  isActive(): boolean

  /**
   * Send raw data to a target address on this transport.
   * The address format depends on the transport (ygg IPv6, host:port, etc).
   */
  send(target: string, data: Buffer): Promise<void>

  /** Register a handler for incoming data on this transport. */
  onMessage(handler: (from: string, data: Buffer) => void): void

  /** Get the endpoint descriptor for peer announcements. */
  getEndpoint(): TransportEndpoint
}

/**
 * TransportManager handles automatic transport selection and lifecycle.
 *
 * Selection order:
 *   1. Detect Yggdrasil daemon → use YggdrasilTransport
 *   2. Fallback → use UDPTransport (zero-install)
 */
export class TransportManager {
  private _transports: Map<TransportId, Transport> = new Map()
  private _active: Transport | null = null
  private _all: Transport[] = []

  /** Register a transport backend. Order of registration = priority. */
  register(transport: Transport): void {
    this._all.push(transport)
  }

  /**
   * Try each registered transport in order.
   * The first one that starts successfully becomes the active transport.
   */
  async start(identity: Identity, opts?: Record<string, unknown>): Promise<Transport | null> {
    for (const t of this._all) {
      console.log(`[transport] Trying ${t.id}...`)
      const ok = await t.start(identity, opts)
      if (ok) {
        this._transports.set(t.id, t)
        if (!this._active) {
          this._active = t
          console.log(`[transport] Active transport: ${t.id} (${t.address})`)
        } else {
          console.log(`[transport] Fallback available: ${t.id} (${t.address})`)
        }
      } else {
        console.log(`[transport] ${t.id} not available`)
      }
    }
    return this._active
  }

  /** Stop all active transports. */
  async stop(): Promise<void> {
    for (const t of this._transports.values()) {
      await t.stop()
    }
    this._transports.clear()
    this._active = null
  }

  /** Get the primary active transport. */
  get active(): Transport | null {
    return this._active
  }

  /** Get a specific transport by ID if active. */
  get(id: TransportId): Transport | undefined {
    return this._transports.get(id)
  }

  /** Get all active transports. */
  getAll(): Transport[] {
    return Array.from(this._transports.values())
  }

  /** Get endpoints for all active transports (for peer announcements). */
  getEndpoints(): Endpoint[] {
    return Array.from(this._transports.values()).map((t) => {
      const ep = t.getEndpoint()
      return {
        transport: ep.transport as Endpoint["transport"],
        address: ep.address,
        port: ep.port,
        priority: ep.priority,
        ttl: ep.ttl,
      }
    })
  }

  /** Find a transport that can reach the given address. */
  resolveTransport(address: string): Transport | null {
    // Yggdrasil addresses start with 2xx:
    if (/^2[0-9a-f]{2}:/i.test(address)) {
      return this._transports.get("yggdrasil") ?? this._active
    }
    // host:port format → QUIC
    if (address.includes(":") && /\d+$/.test(address)) {
      return this._transports.get("quic") ?? this._active
    }
    return this._active
  }
}
