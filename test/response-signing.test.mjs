/**
 * P2a — AgentWorld response signing
 *
 * Verifies that /peer/* endpoints include X-AgentWorld-Signature,
 * X-AgentWorld-From, Content-Digest and other required headers, and that
 * the signature is cryptographically valid over the response body.
 */
import { test, describe, before, after } from "node:test"
import assert from "node:assert/strict"
import * as os from "node:os"
import * as fs from "node:fs"
import * as path from "node:path"
import crypto from "node:crypto"

import { createRequire } from "node:module"
const require = createRequire(import.meta.url)
const pkgVersion = require("../package.json").version
const PROTOCOL_VERSION = pkgVersion.split(".").slice(0, 2).join(".")

const nacl = (await import("tweetnacl")).default

const { startPeerServer, stopPeerServer } = await import("../dist/peer-server.js")
const { initDb } = await import("../dist/peer-db.js")
const { agentIdFromPublicKey, DOMAIN_SEPARATORS } = await import("../dist/identity.js")

const PORT = 18110

function makeKeypair() {
  const kp = nacl.sign.keyPair()
  const pubB64 = Buffer.from(kp.publicKey).toString("base64")
  const privB64 = Buffer.from(kp.secretKey.slice(0, 32)).toString("base64")
  const agentId = agentIdFromPublicKey(pubB64)
  return { publicKey: pubB64, privateKey: privB64, agentId, secretKey: kp.secretKey }
}

function computeContentDigest(body) {
  const hash = crypto.createHash("sha256").update(Buffer.from(body, "utf8")).digest("base64")
  return `sha-256=:${hash}:`
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === "object") {
    const sorted = {}
    for (const k of Object.keys(value).sort()) sorted[k] = canonicalize(value[k])
    return sorted
  }
  return value
}

function verifyResponseSig(headers, status, body, publicKeyB64) {
  const sig = headers.get("x-agentworld-signature")
  const from = headers.get("x-agentworld-from")
  const kid = headers.get("x-agentworld-keyid")
  const ts = headers.get("x-agentworld-timestamp")
  const cd = headers.get("content-digest")

  if (!sig || !from || !kid || !ts || !cd) return { ok: false, missing: true }

  const expectedDigest = computeContentDigest(body)
  if (cd !== expectedDigest) return { ok: false, digestMismatch: true }

  const signingInput = canonicalize({ v: PROTOCOL_VERSION, from, kid, ts, status, contentDigest: cd })
  const pubBytes = Buffer.from(publicKeyB64, "base64")
  const sigBytes = Buffer.from(sig, "base64")
  const prefix = Buffer.from(DOMAIN_SEPARATORS.HTTP_RESPONSE)
  const payload = Buffer.from(JSON.stringify(signingInput))
  const msg = Buffer.concat([prefix, payload])
  const valid = nacl.sign.detached.verify(msg, sigBytes, pubBytes)
  return { ok: valid }
}

describe("P2a — response signing on /peer/* endpoints", () => {
  let tmpDir
  let selfKey

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dap-rsig-"))
    initDb(tmpDir)
    selfKey = makeKeypair()
    await startPeerServer(PORT, { testMode: true, identity: { agentId: selfKey.agentId, publicKey: selfKey.publicKey, privateKey: selfKey.privateKey } })
  })

  after(async () => {
    await stopPeerServer()
    fs.rmSync(tmpDir, { recursive: true })
  })

  test("/peer/ping response has valid AgentWorld signature headers", async () => {
    const resp = await fetch(`http://[::1]:${PORT}/peer/ping`)
    const body = await resp.text()
    assert.equal(resp.status, 200)

    assert.ok(resp.headers.get("x-agentworld-signature"), "missing X-AgentWorld-Signature")
    assert.ok(resp.headers.get("x-agentworld-from"), "missing X-AgentWorld-From")
    assert.ok(resp.headers.get("x-agentworld-keyid"), "missing X-AgentWorld-KeyId")
    assert.ok(resp.headers.get("x-agentworld-timestamp"), "missing X-AgentWorld-Timestamp")
    assert.ok(resp.headers.get("content-digest"), "missing Content-Digest")

    const result = verifyResponseSig(resp.headers, 200, body, selfKey.publicKey)
    assert.ok(result.ok, `Response signature invalid: ${JSON.stringify(result)}`)
  })

  test("/peer/message error response (non-co-member) has valid signature", async () => {
    const otherKey = makeKeypair()
    const body = JSON.stringify({
      from: otherKey.agentId,
      publicKey: otherKey.publicKey,
      event: "chat",
      content: "test",
      timestamp: Date.now(),
    })
    const { signHttpRequest } = await import("../dist/identity.js")
    const awHeaders = signHttpRequest(otherKey, "POST", `[::1]:${PORT}`, "/peer/message", body)
    const resp = await fetch(`http://[::1]:${PORT}/peer/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...awHeaders },
      body,
    })
    const respBody = await resp.text()
    assert.equal(resp.status, 403)
    const result = verifyResponseSig(resp.headers, 403, respBody, selfKey.publicKey)
    assert.ok(result.ok, `Error response signature invalid: ${JSON.stringify(result)}`)
  })

  test("/peer/message error response has valid signature", async () => {
    const resp = await fetch(`http://[::1]:${PORT}/peer/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bad: "payload" }),
    })
    const body = await resp.text()
    assert.equal(resp.status, 400)
    const result = verifyResponseSig(resp.headers, 400, body, selfKey.publicKey)
    assert.ok(result.ok, `Error response signature invalid: ${JSON.stringify(result)}`)
  })
})
