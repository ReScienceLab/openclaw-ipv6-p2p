import crypto from "node:crypto"
import nacl from "tweetnacl"

export function agentIdFromPublicKey(publicKeyB64: string): string {
  return crypto.createHash("sha256")
    .update(Buffer.from(publicKeyB64, "base64"))
    .digest("hex")
    .slice(0, 32)
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(value as object).sort()) {
      sorted[k] = canonicalize((value as Record<string, unknown>)[k])
    }
    return sorted
  }
  return value
}

export function verifySignature(publicKeyB64: string, obj: unknown, signatureB64: string): boolean {
  try {
    const pubKey = Buffer.from(publicKeyB64, "base64")
    const sig = Buffer.from(signatureB64, "base64")
    const msg = Buffer.from(JSON.stringify(canonicalize(obj)))
    return nacl.sign.detached.verify(msg, sig, pubKey)
  } catch {
    return false
  }
}

export function signPayload(payload: unknown, secretKey: Uint8Array): string {
  const sig = nacl.sign.detached(
    Buffer.from(JSON.stringify(canonicalize(payload))),
    secretKey
  )
  return Buffer.from(sig).toString("base64")
}
