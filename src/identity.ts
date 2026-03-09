/**
 * Identity management: Ed25519 keypair generation and agent ID derivation.
 *
 * The Ed25519 keypair is the single source of truth for agent identity.
 * Everything else — network addresses, transport protocols — is transient.
 */
import * as nacl from "tweetnacl"
import { sha256 } from "@noble/hashes/sha256"
import { sha512 } from "@noble/hashes/sha512"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { Identity } from "./types"

// ── Address derivation (used by Yggdrasil transport) ────────────────────────

const ULA_PREFIX = Buffer.from("fd00deadbeef0000", "hex")

export function deriveCgaIpv6(publicKeyBytes: Uint8Array): string {
  const h = sha256(publicKeyBytes)
  const ipv6Bytes = Buffer.alloc(16)
  ULA_PREFIX.copy(ipv6Bytes, 0, 0, 8)
  Buffer.from(h).copy(ipv6Bytes, 8, 24, 32)
  const parts: string[] = []
  for (let i = 0; i < 16; i += 2) {
    parts.push(ipv6Bytes.readUInt16BE(i).toString(16).padStart(4, "0"))
  }
  return parts.join(":")
}

export function deriveYggIpv6(publicKeyBytes: Uint8Array): string {
  const h = sha512(publicKeyBytes)
  const addr = Buffer.alloc(16)
  addr[0] = 0x02
  Buffer.from(h).copy(addr, 1, 0, 15)
  const parts: string[] = []
  for (let i = 0; i < 16; i += 2) {
    parts.push(addr.readUInt16BE(i).toString(16).padStart(4, "0"))
  }
  return parts.join(":")
}

// ── did:key mapping ─────────────────────────────────────────────────────────

const MULTICODEC_ED25519_PREFIX = Buffer.from([0xed, 0x01])
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

function base58Encode(buf: Buffer): string {
  const digits = [0]
  for (const byte of buf) {
    let carry = byte
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8
      digits[j] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }
  let str = ""
  for (let i = 0; i < buf.length && buf[i] === 0; i++) str += "1"
  for (let i = digits.length - 1; i >= 0; i--) str += BASE58_ALPHABET[digits[i]]
  return str
}

export function deriveDidKey(publicKeyB64: string): string {
  const pubBytes = Buffer.from(publicKeyB64, "base64")
  const prefixed = Buffer.concat([MULTICODEC_ED25519_PREFIX, pubBytes])
  return `did:key:z${base58Encode(prefixed)}`
}

// ── Core identity ───────────────────────────────────────────────────────────

export function agentIdFromPublicKey(publicKeyB64: string): string {
  const pubBytes = Buffer.from(publicKeyB64, "base64")
  return Buffer.from(sha256(pubBytes)).toString("hex").slice(0, 32)
}

export function generateIdentity(): Identity {
  const keypair = nacl.sign.keyPair()
  const pubBytes = keypair.publicKey
  const privBytes = keypair.secretKey.slice(0, 32)

  const pubB64 = Buffer.from(pubBytes).toString("base64")
  const privB64 = Buffer.from(privBytes).toString("base64")

  const hashHex = Buffer.from(sha256(pubBytes)).toString("hex")
  const agentId = hashHex.slice(0, 32)

  return {
    agentId,
    publicKey: pubB64,
    privateKey: privB64,
  }
}

export function loadOrCreateIdentity(dataDir: string): Identity {
  const idFile = path.join(dataDir, "identity.json")
  if (fs.existsSync(idFile)) {
    const raw = JSON.parse(fs.readFileSync(idFile, "utf-8"))
    if (!raw.agentId && raw.publicKey) {
      raw.agentId = agentIdFromPublicKey(raw.publicKey)
      fs.writeFileSync(idFile, JSON.stringify(raw, null, 2))
    }
    return raw as Identity
  }
  fs.mkdirSync(dataDir, { recursive: true })
  const id = generateIdentity()
  fs.writeFileSync(idFile, JSON.stringify(id, null, 2))
  return id
}

// ── Canonical serialization + signing ───────────────────────────────────────

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = canonicalize((value as Record<string, unknown>)[k])
    }
    return sorted
  }
  return value
}

export function signMessage(privateKeyB64: string, data: Record<string, unknown>): string {
  const privBytes = Buffer.from(privateKeyB64, "base64")
  const privFull = nacl.sign.keyPair.fromSeed(privBytes)
  const msg = Buffer.from(JSON.stringify(canonicalize(data)))
  const sig = nacl.sign.detached(msg, privFull.secretKey)
  return Buffer.from(sig).toString("base64")
}

export function verifySignature(
  publicKeyB64: string,
  data: Record<string, unknown>,
  signatureB64: string
): boolean {
  try {
    const pubBytes = Buffer.from(publicKeyB64, "base64")
    const sigBytes = Buffer.from(signatureB64, "base64")
    const msg = Buffer.from(JSON.stringify(canonicalize(data)))
    return nacl.sign.detached.verify(msg, sigBytes, pubBytes)
  } catch {
    return false
  }
}

// ── Utility ─────────────────────────────────────────────────────────────────

export function getActualIpv6(): string | null {
  const ifaces = os.networkInterfaces()
  for (const iface of Object.values(ifaces)) {
    if (!iface) continue
    for (const info of iface) {
      if (info.family === "IPv6" && !info.internal && !info.address.startsWith("fe80:")) {
        return info.address
      }
    }
  }
  return null
}
