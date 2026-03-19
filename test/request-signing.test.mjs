/**
 * AgentWorld v0.2 request signing — round-trip tests
 *
 * Verifies that:
 *   1. sendP2PMessage includes X-AgentWorld-* headers
 *   2. Server verifies v0.2 header signatures correctly
 *   3. Server still accepts legacy body-only signed messages
 *   4. Content-Digest mismatch is rejected
 *   5. Timestamp skew is rejected via headers
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
const { initDb, flushDb } = await import("../dist/peer-db.js")
const {
  agentIdFromPublicKey,
  signMessage,
  canonicalize,
  signHttpRequest,
  verifyHttpRequestHeaders,
  verifyHttpResponseHeaders,
  computeContentDigest,
} = await import("../dist/identity.js")
const { sendP2PMessage } = await import("../dist/peer-client.js")

const PORT = 18115

function makeIdentity() {
  const kp = nacl.sign.keyPair()
  const pubB64 = Buffer.from(kp.publicKey).toString("base64")
  const privB64 = Buffer.from(kp.secretKey.slice(0, 32)).toString("base64")
  const agentId = agentIdFromPublicKey(pubB64)
  return { publicKey: pubB64, privateKey: privB64, agentId }
}

let selfKey, senderKey, dataDir

describe("v0.2 request signing", () => {
  before(async () => {
    selfKey = makeIdentity()
    senderKey = makeIdentity()
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dap-reqsign-"))
    initDb(dataDir)
    await startPeerServer(PORT, { identity: selfKey, testMode: true })
  })

  after(async () => {
    await stopPeerServer()
    flushDb()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  test("signHttpRequest produces all 6 required headers", () => {
    const body = JSON.stringify({ test: true })
    const headers = signHttpRequest(senderKey, "POST", "localhost:8099", "/peer/message", body)
    assert.ok(headers["X-AgentWorld-Version"])
    assert.ok(headers["X-AgentWorld-From"])
    assert.ok(headers["X-AgentWorld-KeyId"])
    assert.ok(headers["X-AgentWorld-Timestamp"])
    assert.ok(headers["Content-Digest"])
    assert.ok(headers["X-AgentWorld-Signature"])
    assert.equal(headers["X-AgentWorld-Version"], PROTOCOL_VERSION)
    assert.equal(headers["X-AgentWorld-From"], senderKey.agentId)
    assert.equal(headers["X-AgentWorld-KeyId"], "#identity")
  })

  test("signHttpRequest + verifyHttpRequestHeaders round-trip", () => {
    const body = JSON.stringify({ from: senderKey.agentId, content: "hello" })
    const headers = signHttpRequest(senderKey, "POST", "example.com:8099", "/peer/message", body)
    const result = verifyHttpRequestHeaders(
      headers, "POST", "/peer/message", "example.com:8099", body, senderKey.publicKey
    )
    assert.ok(result.ok, `Verification failed: ${result.error}`)
  })

  test("verifyHttpRequestHeaders rejects tampered body", () => {
    const body = JSON.stringify({ from: senderKey.agentId, content: "hello" })
    const headers = signHttpRequest(senderKey, "POST", "example.com:8099", "/peer/message", body)
    const tampered = JSON.stringify({ from: senderKey.agentId, content: "tampered" })
    const result = verifyHttpRequestHeaders(
      headers, "POST", "/peer/message", "example.com:8099", tampered, senderKey.publicKey
    )
    assert.equal(result.ok, false)
    assert.match(result.error, /Content-Digest mismatch/)
  })

  test("verifyHttpRequestHeaders rejects wrong public key", () => {
    const body = JSON.stringify({ from: senderKey.agentId, content: "hello" })
    const headers = signHttpRequest(senderKey, "POST", "example.com:8099", "/peer/message", body)
    const otherKey = makeIdentity()
    const result = verifyHttpRequestHeaders(
      headers, "POST", "/peer/message", "example.com:8099", body, otherKey.publicKey
    )
    assert.equal(result.ok, false)
    assert.match(result.error, /Invalid X-AgentWorld-Signature/)
  })

  test("verifyHttpRequestHeaders rejects wrong path (replay to different endpoint)", () => {
    const body = JSON.stringify({ from: senderKey.agentId, content: "hello" })
    const headers = signHttpRequest(senderKey, "POST", "example.com:8099", "/peer/message", body)
    const result = verifyHttpRequestHeaders(
      headers, "POST", "/peer/announce", "example.com:8099", body, senderKey.publicKey
    )
    assert.equal(result.ok, false)
    assert.match(result.error, /Invalid X-AgentWorld-Signature/)
  })

  test("verifyHttpRequestHeaders rejects expired timestamp", () => {
    const body = JSON.stringify({ test: true })
    const contentDigest = computeContentDigest(body)
    const ts = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const signingInput = canonicalize({
      v: PROTOCOL_VERSION,
      from: senderKey.agentId,
      kid: "#identity",
      ts,
      method: "POST",
      authority: "example.com:8099",
      path: "/peer/message",
      contentDigest,
    })
    const kp = nacl.sign.keyPair.fromSeed(Buffer.from(senderKey.privateKey, "base64"))
    const sig = nacl.sign.detached(Buffer.from(JSON.stringify(signingInput)), kp.secretKey)
    const headers = {
      "X-AgentWorld-Version": PROTOCOL_VERSION,
      "X-AgentWorld-From": senderKey.agentId,
      "X-AgentWorld-KeyId": "#identity",
      "X-AgentWorld-Timestamp": ts,
      "Content-Digest": contentDigest,
      "X-AgentWorld-Signature": Buffer.from(sig).toString("base64"),
    }
    const result = verifyHttpRequestHeaders(
      headers, "POST", "/peer/message", "example.com:8099", body, senderKey.publicKey
    )
    assert.equal(result.ok, false)
    assert.match(result.error, /skew window/)
  })

  test("sendP2PMessage delivers with v0.2 headers (server accepts)", async () => {
    const result = await sendP2PMessage(
      senderKey, "::1", "chat", "hello via v0.2", PORT, 5000
    )
    assert.ok(result.ok, `Send failed: ${result.error}`)
  })

  test("server accepts legacy body-only signed message (no v0.2 headers)", async () => {
    const timestamp = Date.now()
    const payload = {
      from: senderKey.agentId,
      publicKey: senderKey.publicKey,
      event: "chat",
      content: "legacy message",
      timestamp,
    }
    const signature = signMessage(senderKey.privateKey, payload)
    const msg = { ...payload, signature }

    const resp = await fetch(`http://[::1]:${PORT}/peer/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg),
    })
    assert.equal(resp.status, 200)
    const body = await resp.json()
    assert.ok(body.ok)
  })

  test("server rejects v0.2 request with tampered body", async () => {
    const original = JSON.stringify({
      from: senderKey.agentId,
      publicKey: senderKey.publicKey,
      event: "chat",
      content: "original",
      timestamp: Date.now(),
      signature: "unused",
    })
    const awHeaders = signHttpRequest(senderKey, "POST", `[::1]:${PORT}`, "/peer/message", original)

    const tampered = JSON.stringify({
      from: senderKey.agentId,
      publicKey: senderKey.publicKey,
      event: "chat",
      content: "tampered!",
      timestamp: Date.now(),
      signature: "unused",
    })

    const resp = await fetch(`http://[::1]:${PORT}/peer/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...awHeaders },
      body: tampered,
    })
    assert.equal(resp.status, 403)
    const body = await resp.json()
    assert.match(body.error, /Content-Digest mismatch/)
  })

  test("server rejects v0.2 request signed with wrong key", async () => {
    const otherKey = makeIdentity()
    const msgBody = JSON.stringify({
      from: senderKey.agentId,
      publicKey: senderKey.publicKey,
      event: "chat",
      content: "wrong signer",
      timestamp: Date.now(),
      signature: "unused",
    })
    const awHeaders = signHttpRequest(otherKey, "POST", `[::1]:${PORT}`, "/peer/message", msgBody)

    const resp = await fetch(`http://[::1]:${PORT}/peer/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...awHeaders },
      body: msgBody,
    })
    assert.equal(resp.status, 403)
  })

  test("announce with v0.2 headers is accepted", async () => {
    const timestamp = Date.now()
    const payload = {
      from: senderKey.agentId,
      publicKey: senderKey.publicKey,
      alias: "test-node",
      endpoints: [],
      capabilities: [],
      timestamp,
      peers: [],
    }
    const signature = signMessage(senderKey.privateKey, payload)
    const announcement = { ...payload, signature }
    const body = JSON.stringify(announcement)
    const awHeaders = signHttpRequest(senderKey, "POST", `[::1]:${PORT}`, "/peer/announce", body)

    const resp = await fetch(`http://[::1]:${PORT}/peer/announce`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...awHeaders },
      body,
    })
    assert.equal(resp.status, 200)
    const result = await resp.json()
    assert.ok(result.ok || result.peers)
  })

  test("response includes v0.2 signing headers", async () => {
    const timestamp = Date.now()
    const payload = {
      from: senderKey.agentId,
      publicKey: senderKey.publicKey,
      event: "chat",
      content: "check response headers",
      timestamp,
    }
    const signature = signMessage(senderKey.privateKey, payload)
    const msg = { ...payload, signature }

    const resp = await fetch(`http://[::1]:${PORT}/peer/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg),
    })
    assert.equal(resp.status, 200)
    assert.ok(resp.headers.get("x-agentworld-signature"))
    assert.ok(resp.headers.get("x-agentworld-from"))
    assert.ok(resp.headers.get("x-agentworld-version"))
    assert.ok(resp.headers.get("x-agentworld-keyid"))
    assert.ok(resp.headers.get("x-agentworld-timestamp"))
    assert.ok(resp.headers.get("content-digest"))
  })

  test("computeContentDigest handles empty body", () => {
    const digest = computeContentDigest("")
    assert.ok(digest.startsWith("sha-256=:"))
    assert.ok(digest.endsWith(":"))
    const inner = digest.slice("sha-256=:".length, -1)
    assert.ok(inner.length > 0, "digest should not be empty")
    // SHA-256 of empty string is well-known
    const expected = crypto.createHash("sha256").update("").digest("base64")
    assert.equal(inner, expected)
  })

  test("verifyHttpResponseHeaders validates server response", async () => {
    const timestamp = Date.now()
    const payload = {
      from: senderKey.agentId,
      publicKey: senderKey.publicKey,
      event: "chat",
      content: "verify response",
      timestamp,
    }
    const signature = signMessage(senderKey.privateKey, payload)
    const msg = { ...payload, signature }

    const resp = await fetch(`http://[::1]:${PORT}/peer/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg),
    })
    assert.equal(resp.status, 200)
    const body = await resp.text()
    const respHeaders = {}
    for (const [k, v] of resp.headers.entries()) respHeaders[k] = v
    const result = verifyHttpResponseHeaders(respHeaders, 200, body, selfKey.publicKey)
    assert.ok(result.ok, `Response header verification failed: ${result.error}`)
  })

  test("server rejects v0.2 request with mismatched from header vs body", async () => {
    const otherKey = makeIdentity()
    const msgBody = JSON.stringify({
      from: senderKey.agentId,
      publicKey: senderKey.publicKey,
      event: "chat",
      content: "mismatched from",
      timestamp: Date.now(),
      signature: "unused",
    })
    // Sign with senderKey but the body says from=senderKey while header will say from=otherKey
    const awHeaders = signHttpRequest(otherKey, "POST", `[::1]:${PORT}`, "/peer/message", msgBody)

    const resp = await fetch(`http://[::1]:${PORT}/peer/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...awHeaders },
      body: msgBody,
    })
    // Should fail because header signature was signed with otherKey's publicKey
    // but body says publicKey=senderKey.publicKey, and verification uses body's publicKey
    assert.ok(resp.status === 403 || resp.status === 400)
  })
})
