import fs from "fs"
import path from "path"
import nacl from "tweetnacl"
import { agentIdFromPublicKey } from "./crypto.js"
import type { Identity } from "./types.js"

// ── did:key / multibase ──────────────────────────────────────────────────────

const MULTICODEC_ED25519_PREFIX = Buffer.from([0xed, 0x01])
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

export function base58Encode(buf: Buffer): string {
  if (buf.length === 0) return ""

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
  let leadingZeroCount = 0
  while (leadingZeroCount < buf.length && buf[leadingZeroCount] === 0) leadingZeroCount++

  let str = "1".repeat(leadingZeroCount)
  if (leadingZeroCount === buf.length) return str

  for (let i = digits.length - 1; i >= 0; i--) str += BASE58_ALPHABET[digits[i]]
  return str
}

/** Returns `did:key:z<base58(multicodec_ed25519 + pubBytes)>` */
export function deriveDidKey(pubB64: string): string {
  const pubBytes = Buffer.from(pubB64, "base64")
  const prefixed = Buffer.concat([MULTICODEC_ED25519_PREFIX, pubBytes])
  return `did:key:z${base58Encode(prefixed)}`
}

/** Returns the `z<base58multicodec>` multibase string for the public key */
export function toPublicKeyMultibase(pubB64: string): string {
  return deriveDidKey(pubB64).slice("did:key:".length)
}

/**
 * Load an existing Ed25519 identity from dataDir or create a new one.
 * @param dataDir  Directory where identity file is stored
 * @param name     Identity file name (without .json), e.g. "world-identity" or "gateway-identity"
 */
export function loadOrCreateIdentity(dataDir: string, name = "identity"): Identity {
  fs.mkdirSync(dataDir, { recursive: true })
  const idFile = path.join(dataDir, `${name}.json`)

  let keypair: nacl.SignKeyPair
  if (fs.existsSync(idFile)) {
    const saved = JSON.parse(fs.readFileSync(idFile, "utf8")) as { seed: string }
    keypair = nacl.sign.keyPair.fromSeed(Buffer.from(saved.seed, "base64"))
  } else {
    const seed = nacl.randomBytes(32)
    keypair = nacl.sign.keyPair.fromSeed(seed)
    fs.writeFileSync(idFile, JSON.stringify({
      seed: Buffer.from(seed).toString("base64"),
      publicKey: Buffer.from(keypair.publicKey).toString("base64"),
    }, null, 2))
  }

  const pubB64 = Buffer.from(keypair.publicKey).toString("base64")
  return {
    agentId: agentIdFromPublicKey(pubB64),
    pubB64,
    secretKey: keypair.secretKey,
    keypair,
  }
}
