/**
 * UDP transport backend — zero-install fallback when Yggdrasil is unavailable.
 *
 * IMPORTANT: This is a plain UDP datagram transport, NOT a real QUIC
 * implementation. It provides:
 *   - Unencrypted, unreliable UDP delivery (no retransmission, no ordering)
 *   - STUN-assisted NAT traversal for public endpoint discovery
 *   - Messages >MTU (~1400 bytes) may be silently dropped
 *
 * Security relies entirely on the application-layer Ed25519 signatures.
 * When Node.js native QUIC (node:quic, Node 24+) becomes stable, this
 * transport should be upgraded to use it for transport-layer encryption.
 */
import * as dgram from "node:dgram"
import * as net from "node:net"
import { Transport, TransportId, TransportEndpoint } from "./transport"
import { Identity } from "./types"
import { getActualIpv6 } from "./identity"

/** Well-known public STUN servers for NAT traversal. */
const STUN_SERVERS = [
  "stun.l.google.com:19302",
  "stun1.l.google.com:19302",
  "stun.cloudflare.com:3478",
]

/** Check if Node.js native QUIC is available (node:quic, Node 24+). */
function isNativeQuicAvailable(): boolean {
  try {
    require("node:quic")
    return true
  } catch {
    return false
  }
}

/**
 * Perform a simple STUN binding request to discover our public IP:port.
 * Returns null if STUN fails (e.g., no internet, firewall).
 */
async function stunDiscover(
  socket: dgram.Socket,
  stunServer: string,
  timeoutMs: number = 5000
): Promise<{ address: string; port: number } | null> {
  const [host, portStr] = stunServer.split(":")
  const port = parseInt(portStr, 10)

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs)

    // STUN Binding Request (RFC 5389 minimal)
    // Magic cookie: 0x2112A442
    const txId = Buffer.alloc(12)
    for (let i = 0; i < 12; i++) txId[i] = Math.floor(Math.random() * 256)

    const msg = Buffer.alloc(20)
    msg.writeUInt16BE(0x0001, 0) // Binding Request
    msg.writeUInt16BE(0x0000, 2) // Message Length
    msg.writeUInt32BE(0x2112a442, 4) // Magic Cookie
    txId.copy(msg, 8)

    const onMessage = (data: Buffer) => {
      clearTimeout(timer)
      socket.removeListener("message", onMessage)

      // Parse XOR-MAPPED-ADDRESS from STUN response
      const parsed = parseStunResponse(data)
      resolve(parsed)
    }

    socket.on("message", onMessage)

    // Resolve STUN server hostname before sending
    require("node:dns").lookup(host, { family: 4 }, (err: Error | null, address: string) => {
      if (err) {
        clearTimeout(timer)
        socket.removeListener("message", onMessage)
        resolve(null)
        return
      }
      socket.send(msg, 0, msg.length, port, address)
    })
  })
}

/** Parse a STUN Binding Response to extract the mapped address. */
function parseStunResponse(data: Buffer): { address: string; port: number } | null {
  if (data.length < 20) return null

  const msgType = data.readUInt16BE(0)
  if (msgType !== 0x0101) return null // Not a Binding Success Response

  const msgLen = data.readUInt16BE(2)
  let offset = 20

  while (offset < 20 + msgLen) {
    const attrType = data.readUInt16BE(offset)
    const attrLen = data.readUInt16BE(offset + 2)
    offset += 4

    // XOR-MAPPED-ADDRESS (0x0020) or MAPPED-ADDRESS (0x0001)
    if (attrType === 0x0020 && attrLen >= 8) {
      const family = data[offset + 1]
      if (family === 0x01) { // IPv4
        const xPort = data.readUInt16BE(offset + 2) ^ 0x2112
        const xAddr = data.readUInt32BE(offset + 4) ^ 0x2112a442
        const a = (xAddr >>> 24) & 0xff
        const b = (xAddr >>> 16) & 0xff
        const c = (xAddr >>> 8) & 0xff
        const d = xAddr & 0xff
        return { address: `${a}.${b}.${c}.${d}`, port: xPort }
      }
    } else if (attrType === 0x0001 && attrLen >= 8) {
      const family = data[offset + 1]
      if (family === 0x01) { // IPv4
        const port = data.readUInt16BE(offset + 2)
        const a = data[offset + 4]
        const b = data[offset + 5]
        const c = data[offset + 6]
        const d = data[offset + 7]
        return { address: `${a}.${b}.${c}.${d}`, port }
      }
    }

    offset += attrLen
    // Pad to 4-byte boundary
    if (attrLen % 4 !== 0) offset += 4 - (attrLen % 4)
  }

  return null
}

export class UDPTransport implements Transport {
  readonly id: TransportId = "quic"
  private _address: string = ""
  private _port: number = 0
  private _active: boolean = false
  private _socket: dgram.Socket | null = null
  private _handlers: Array<(from: string, data: Buffer) => void> = []
  private _publicEndpoint: { address: string; port: number } | null = null
  private _useNativeQuic: boolean = false

  get address(): string {
    return this._address
  }

  get publicEndpoint() {
    return this._publicEndpoint
  }

  async start(identity: Identity, opts?: Record<string, unknown>): Promise<boolean> {
    const port = (opts?.quicPort as number) ?? 8098
    const testMode = (opts?.testMode as boolean) ?? false

    // Check for native QUIC support first
    this._useNativeQuic = isNativeQuicAvailable()
    if (this._useNativeQuic) {
      console.log("[transport:quic] Native QUIC available (node:quic)")
    }

    try {
      // Create UDP socket for QUIC transport
      this._socket = dgram.createSocket("udp6")

      await new Promise<void>((resolve, reject) => {
        this._socket!.on("error", reject)
        this._socket!.bind(port, "::", () => {
          this._socket!.removeListener("error", reject)
          resolve()
        })
      })

      const actualPort = this._socket.address().port
      this._port = actualPort

      // Set up message handler
      this._socket.on("message", (msg, rinfo) => {
        const from = rinfo.address.includes(":") ? `[${rinfo.address}]:${rinfo.port}` : `${rinfo.address}:${rinfo.port}`
        for (const h of this._handlers) {
          h(from, msg)
        }
      })

      // Try STUN discovery for public endpoint (skip in test mode).
      // We also create a companion IPv4 UDP socket on the same port so the
      // STUN-mapped port matches the port we are actually listening on.
      if (!testMode) {
        let stunSocket: dgram.Socket | null = null
        try {
          stunSocket = dgram.createSocket("udp4")
          await new Promise<void>((resolve, reject) => {
            stunSocket!.on("error", reject)
            stunSocket!.bind(actualPort, () => {
              stunSocket!.removeListener("error", reject)
              resolve()
            })
          })
        } catch {
          // Port already taken on IPv4 — fall back to ephemeral port
          try { stunSocket?.close() } catch { /* ignore */ }
          stunSocket = dgram.createSocket("udp4")
          await new Promise<void>((resolve, reject) => {
            stunSocket!.on("error", reject)
            stunSocket!.bind(0, () => {
              stunSocket!.removeListener("error", reject)
              resolve()
            })
          }).catch(() => { stunSocket = null })
        }

        if (stunSocket) {
          for (const server of STUN_SERVERS) {
            try {
              const result = await stunDiscover(stunSocket, server, 3000)
              if (result) {
                this._publicEndpoint = result
                // Use STUN-discovered public IP but always advertise the actual
                // listening port (in case STUN socket was ephemeral).
                this._address = `${result.address}:${actualPort}`
                console.log(`[transport:quic] Public endpoint: ${this._address} (via ${server})`)
                break
              }
            } catch { /* try next */ }
          }
          try { stunSocket.close() } catch { /* ignore */ }
        }
      }

      // Fallback to local address if STUN failed
      if (!this._address) {
        const localIp = getActualIpv6() ?? "::1"
        this._address = `[${localIp}]:${actualPort}`
        console.log(`[transport:quic] Local endpoint: ${this._address} (STUN unavailable)`)
      }

      this._active = true
      console.log(`[transport:quic] Listening on UDP port ${actualPort}`)
      return true
    } catch (err: any) {
      console.warn(`[transport:quic] Failed to start: ${err?.message}`)
      return false
    }
  }

  async stop(): Promise<void> {
    this._active = false
    if (this._socket) {
      this._socket.close()
      this._socket = null
    }
  }

  isActive(): boolean {
    return this._active
  }

  async send(target: string, data: Buffer): Promise<void> {
    if (!this._socket || !this._active) {
      throw new Error("QUIC transport not active")
    }

    const { host, port } = parseHostPort(target)

    return new Promise((resolve, reject) => {
      this._socket!.send(data, 0, data.length, port, host, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  onMessage(handler: (from: string, data: Buffer) => void): void {
    this._handlers.push(handler)
  }

  getEndpoint(): TransportEndpoint {
    return {
      transport: "quic",
      address: this._address,
      port: this._port,
      priority: 10,
      ttl: 3600,
    }
  }
}

/** Parse a host:port or [host]:port string. */
function parseHostPort(addr: string): { host: string; port: number } {
  // [ipv6]:port format
  const bracketMatch = addr.match(/^\[([^\]]+)\]:(\d+)$/)
  if (bracketMatch) {
    return { host: bracketMatch[1], port: parseInt(bracketMatch[2], 10) }
  }
  // host:port (IPv4 or hostname)
  const lastColon = addr.lastIndexOf(":")
  if (lastColon > 0) {
    return {
      host: addr.slice(0, lastColon),
      port: parseInt(addr.slice(lastColon + 1), 10),
    }
  }
  throw new Error(`Invalid address format: ${addr}`)
}

export { parseHostPort, isNativeQuicAvailable, stunDiscover, parseStunResponse }
