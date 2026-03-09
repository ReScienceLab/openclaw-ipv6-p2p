/**
 * Yggdrasil transport backend.
 *
 * Wraps existing Yggdrasil daemon management (detect external / spawn managed)
 * behind the Transport interface. Uses HTTP over Yggdrasil IPv6 for messaging.
 */
import { Transport, TransportId, TransportEndpoint } from "./transport"
import { Identity, YggdrasilInfo } from "./types"
import {
  startYggdrasil,
  stopYggdrasil,
  isYggdrasilAvailable,
  detectExternalYggdrasil,
  getYggdrasilNetworkInfo,
} from "./yggdrasil"

export class YggdrasilTransport implements Transport {
  readonly id: TransportId = "yggdrasil"
  private _address: string = ""
  private _info: YggdrasilInfo | null = null
  private _active: boolean = false
  private _handlers: Array<(from: string, data: Buffer) => void> = []
  private _dataDir: string = ""

  get address(): string {
    return this._address
  }

  get info(): YggdrasilInfo | null {
    return this._info
  }

  get networkInfo() {
    return getYggdrasilNetworkInfo()
  }

  async start(identity: Identity, opts?: Record<string, unknown>): Promise<boolean> {
    this._dataDir = (opts?.dataDir as string) ?? ""
    const extraPeers = (opts?.extraPeers as string[]) ?? []

    // Check if yggdrasil binary exists
    if (!isYggdrasilAvailable()) {
      return false
    }

    // Try to detect an existing daemon first
    const external = detectExternalYggdrasil()
    if (external) {
      this._info = external
      this._address = external.address
      this._active = true
      identity.yggIpv6 = external.address
      console.log(`[transport:yggdrasil] Connected to external daemon: ${external.address}`)
      return true
    }

    // Try to spawn a managed daemon
    if (this._dataDir) {
      const info = await startYggdrasil(this._dataDir, extraPeers)
      if (info) {
        this._info = info
        this._address = info.address
        this._active = true
        identity.yggIpv6 = info.address
        console.log(`[transport:yggdrasil] Started managed daemon: ${info.address}`)
        return true
      }
    }

    return false
  }

  async stop(): Promise<void> {
    this._active = false
    stopYggdrasil()
  }

  isActive(): boolean {
    return this._active
  }

  async send(_target: string, _data: Buffer): Promise<void> {
    // Yggdrasil messaging uses the HTTP peer-server/peer-client path, not raw
    // transport-level sends. This is intentionally a no-op to satisfy the
    // Transport interface contract without throwing.
  }

  onMessage(handler: (from: string, data: Buffer) => void): void {
    this._handlers.push(handler)
  }

  getEndpoint(): TransportEndpoint {
    return {
      transport: "yggdrasil",
      address: this._address,
      port: 8099,
      priority: 10,
      ttl: 86400,
    }
  }

  /**
   * Try to hot-connect to an external Yggdrasil daemon.
   * Used when daemon becomes available after initial startup.
   */
  tryHotConnect(identity: Identity): boolean {
    if (this._active) return true
    const ext = detectExternalYggdrasil()
    if (!ext) return false
    this._info = ext
    this._address = ext.address
    this._active = true
    identity.yggIpv6 = ext.address
    console.log(`[transport:yggdrasil] Hot-connected: ${ext.address}`)
    return true
  }
}
