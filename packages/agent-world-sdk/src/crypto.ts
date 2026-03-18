import crypto from "node:crypto"
import nacl from "tweetnacl"
import { PROTOCOL_VERSION } from "./version.js"

export function agentIdFromPublicKey(publicKeyB64: string): string {
  const fullHex = crypto.createHash("sha256")
    .update(Buffer.from(publicKeyB64, "base64"))
    .digest("hex")
  return `aw:sha256:${fullHex}`
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

// ── AgentWorld v0.2 HTTP header signing ───────────────────────────────────────

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000

export function computeContentDigest(body: string): string {
  const hash = crypto.createHash("sha256").update(Buffer.from(body, "utf8")).digest("base64")
  return `sha-256=:${hash}:`
}

export interface AwRequestHeaders {
  "X-AgentWorld-Version": string
  "X-AgentWorld-From": string
  "X-AgentWorld-KeyId": string
  "X-AgentWorld-Timestamp": string
  "Content-Digest": string
  "X-AgentWorld-Signature": string
}

function buildRequestSigningInput(opts: {
  from: string
  kid: string
  ts: string
  method: string
  authority: string
  path: string
  contentDigest: string
}): Record<string, string> {
  return {
    v: PROTOCOL_VERSION,
    from: opts.from,
    kid: opts.kid,
    ts: opts.ts,
    method: opts.method.toUpperCase(),
    authority: opts.authority,
    path: opts.path,
    contentDigest: opts.contentDigest,
  }
}

/**
 * Produce AgentWorld v0.2 HTTP request signing headers.
 * Include alongside Content-Type in outbound fetch calls.
 */
export function signHttpRequest(
  identity: { agentId: string; secretKey: Uint8Array },
  method: string,
  authority: string,
  path: string,
  body: string
): AwRequestHeaders {
  const ts = new Date().toISOString()
  const kid = "#identity"
  const contentDigest = computeContentDigest(body)
  const signingInput = buildRequestSigningInput({
    from: identity.agentId, kid, ts, method, authority, path, contentDigest,
  })
  const sig = nacl.sign.detached(
    Buffer.from(JSON.stringify(canonicalize(signingInput))),
    identity.secretKey
  )
  return {
    "X-AgentWorld-Version": PROTOCOL_VERSION,
    "X-AgentWorld-From": identity.agentId,
    "X-AgentWorld-KeyId": kid,
    "X-AgentWorld-Timestamp": ts,
    "Content-Digest": contentDigest,
    "X-AgentWorld-Signature": Buffer.from(sig).toString("base64"),
  }
}

/**
 * Verify AgentWorld v0.2 HTTP request headers.
 * Returns { ok: true } if valid, { ok: false, error } otherwise.
 */
export function verifyHttpRequestHeaders(
  headers: Record<string, string | string[] | undefined>,
  method: string,
  path: string,
  authority: string,
  body: string,
  publicKeyB64: string
): { ok: boolean; error?: string } {
  // Normalize to lowercase so callers can pass either Fastify req.headers or raw AwRequestHeaders
  const h: Record<string, string | string[] | undefined> = {}
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v

  const sig = h["x-agentworld-signature"] as string | undefined
  const from = h["x-agentworld-from"] as string | undefined
  const kid = h["x-agentworld-keyid"] as string | undefined
  const ts = h["x-agentworld-timestamp"] as string | undefined
  const cd = h["content-digest"] as string | undefined

  if (!sig || !from || !kid || !ts || !cd) {
    return { ok: false, error: "Missing required AgentWorld headers" }
  }

  const tsDiff = Math.abs(Date.now() - new Date(ts).getTime())
  if (isNaN(tsDiff) || tsDiff > MAX_CLOCK_SKEW_MS) {
    return { ok: false, error: "X-AgentWorld-Timestamp outside acceptable skew window" }
  }

  const expectedDigest = computeContentDigest(body)
  if (cd !== expectedDigest) {
    return { ok: false, error: "Content-Digest mismatch" }
  }

  const signingInput = buildRequestSigningInput({
    from, kid, ts, method, authority, path, contentDigest: cd,
  })
  const ok = verifySignature(publicKeyB64, signingInput, sig)
  return ok ? { ok: true } : { ok: false, error: "Invalid X-AgentWorld-Signature" }
}

// ── AgentWorld v0.2 HTTP response signing ─────────────────────────────────────

export interface AwResponseHeaders {
  "X-AgentWorld-Version": string
  "X-AgentWorld-From": string
  "X-AgentWorld-KeyId": string
  "X-AgentWorld-Timestamp": string
  "Content-Digest": string
  "X-AgentWorld-Signature": string
}

function buildResponseSigningInput(opts: {
  from: string
  kid: string
  ts: string
  status: number
  contentDigest: string
}): Record<string, unknown> {
  return {
    v: PROTOCOL_VERSION,
    from: opts.from,
    kid: opts.kid,
    ts: opts.ts,
    status: opts.status,
    contentDigest: opts.contentDigest,
  }
}

/**
 * Produce AgentWorld v0.2 HTTP response signing headers.
 * Add to Fastify reply before sending the body.
 */
export function signHttpResponse(
  identity: { agentId: string; secretKey: Uint8Array },
  status: number,
  body: string
): AwResponseHeaders {
  const ts = new Date().toISOString()
  const kid = "#identity"
  const contentDigest = computeContentDigest(body)
  const signingInput = buildResponseSigningInput({
    from: identity.agentId, kid, ts, status, contentDigest,
  })
  const sig = nacl.sign.detached(
    Buffer.from(JSON.stringify(canonicalize(signingInput))),
    identity.secretKey
  )
  return {
    "X-AgentWorld-Version": PROTOCOL_VERSION,
    "X-AgentWorld-From": identity.agentId,
    "X-AgentWorld-KeyId": kid,
    "X-AgentWorld-Timestamp": ts,
    "Content-Digest": contentDigest,
    "X-AgentWorld-Signature": Buffer.from(sig).toString("base64"),
  }
}

/**
 * Verify AgentWorld v0.2 HTTP response headers from an inbound response.
 * Returns { ok: true } if valid, { ok: false, error } otherwise.
 */
export function verifyHttpResponseHeaders(
  headers: Record<string, string | null>,
  status: number,
  body: string,
  publicKeyB64: string
): { ok: boolean; error?: string } {
  // Normalize to lowercase so callers can pass title-cased AwResponseHeaders or fetch Headers
  const h: Record<string, string | null> = {}
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v

  const sig = h["x-agentworld-signature"]
  const from = h["x-agentworld-from"]
  const kid = h["x-agentworld-keyid"]
  const ts = h["x-agentworld-timestamp"]
  const cd = h["content-digest"]

  if (!sig || !from || !kid || !ts || !cd) {
    return { ok: false, error: "Missing required AgentWorld response headers" }
  }

  const tsDiff = Math.abs(Date.now() - new Date(ts).getTime())
  if (isNaN(tsDiff) || tsDiff > MAX_CLOCK_SKEW_MS) {
    return { ok: false, error: "X-AgentWorld-Timestamp outside acceptable skew window" }
  }

  const expectedDigest = computeContentDigest(body)
  if (cd !== expectedDigest) {
    return { ok: false, error: "Content-Digest mismatch" }
  }

  const signingInput = buildResponseSigningInput({ from, kid, ts, status, contentDigest: cd })
  const ok = verifySignature(publicKeyB64, signingInput, sig)
  return ok ? { ok: true } : { ok: false, error: "Invalid X-AgentWorld-Signature" }
}
