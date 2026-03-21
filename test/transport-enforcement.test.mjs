/**
 * Transport-layer enforcement — world-scoped isolation
 *
 * Verifies that:
 *   1. /peer/message rejects non-co-members with 403
 *   2. /peer/message accepts co-members
 *   3. UDP messages from non-co-members are silently dropped
 *   4. UDP messages from co-members are accepted
 *   5. addWorldMembers / removeWorld / isCoMember / clearWorldMembers work correctly
 *   6. Removed routes (/peer/inbox, /peer/peers, /peer/announce) return 404
 */
import { test, describe, before, after } from "node:test"
import assert from "node:assert/strict"
import * as os from "node:os"
import * as fs from "node:fs"
import * as path from "node:path"

const nacl = (await import("tweetnacl")).default

const {
  startPeerServer, stopPeerServer,
  addWorldMembers, removeWorld, isCoMember, clearWorldMembers,
  handleUdpMessage,
  onMessage,
} = await import("../dist/peer-server.js")
const { initDb, flushDb } = await import("../dist/peer-db.js")
const { agentIdFromPublicKey, signHttpRequest, signWithDomainSeparator, DOMAIN_SEPARATORS, canonicalize } = await import("../dist/identity.js")

const PORT = 18125

function makeIdentity() {
  const kp = nacl.sign.keyPair()
  const pubB64 = Buffer.from(kp.publicKey).toString("base64")
  const privB64 = Buffer.from(kp.secretKey.slice(0, 32)).toString("base64")
  const agentId = agentIdFromPublicKey(pubB64)
  return { publicKey: pubB64, privateKey: privB64, agentId, secretKey: kp.secretKey }
}

function sendSignedMsg(port, identity, payload) {
  const body = JSON.stringify(canonicalize(payload))
  const awHeaders = signHttpRequest(identity, "POST", `[::1]:${port}`, "/peer/message", body)
  return fetch(`http://[::1]:${port}/peer/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...awHeaders },
    body,
  })
}

function buildUdpMessage(identity, event, content) {
  const msg = {
    from: identity.agentId,
    publicKey: identity.publicKey,
    event,
    content,
    timestamp: Date.now(),
  }
  const sig = signWithDomainSeparator(DOMAIN_SEPARATORS.MESSAGE, msg, identity.secretKey)
  return Buffer.from(JSON.stringify({ ...msg, signature: sig }))
}

describe("Transport enforcement — world-scoped isolation", () => {
  let selfKey, memberKey, strangerKey, tmpDir

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dap-enforce-"))
    initDb(tmpDir)
    selfKey = makeIdentity()
    memberKey = makeIdentity()
    strangerKey = makeIdentity()
    await startPeerServer(PORT, { identity: selfKey, testMode: true })
    addWorldMembers("test-world", [memberKey.agentId])
  })

  after(async () => {
    clearWorldMembers()
    await stopPeerServer()
    flushDb()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── allowlist unit tests ──────────────────────────────────────────────────

  test("isCoMember returns true for added members", () => {
    assert.ok(isCoMember(memberKey.agentId))
  })

  test("isCoMember returns false for strangers", () => {
    assert.equal(isCoMember(strangerKey.agentId), false)
  })

  test("removeWorld clears membership for that world", () => {
    const tmpKey = makeIdentity()
    addWorldMembers("tmp-world", [tmpKey.agentId])
    assert.ok(isCoMember(tmpKey.agentId))
    removeWorld("tmp-world")
    assert.equal(isCoMember(tmpKey.agentId), false)
  })

  test("clearWorldMembers removes all worlds", () => {
    addWorldMembers("w1", ["a1"])
    addWorldMembers("w2", ["a2"])
    assert.ok(isCoMember("a1"))
    clearWorldMembers()
    assert.equal(isCoMember("a1"), false)
    assert.equal(isCoMember("a2"), false)
    // Re-add for subsequent tests
    addWorldMembers("test-world", [memberKey.agentId])
  })

  // ── HTTP /peer/message enforcement ────────────────────────────────────────

  test("/peer/message accepts co-member", async () => {
    const payload = {
      from: memberKey.agentId,
      publicKey: memberKey.publicKey,
      event: "chat",
      content: "hello from member",
      timestamp: Date.now(),
      signature: "placeholder",
    }
    const resp = await sendSignedMsg(PORT, memberKey, payload)
    assert.equal(resp.status, 200)
  })

  test("/peer/message rejects non-co-member with 403", async () => {
    const payload = {
      from: strangerKey.agentId,
      publicKey: strangerKey.publicKey,
      event: "chat",
      content: "hello from stranger",
      timestamp: Date.now(),
      signature: "placeholder",
    }
    const resp = await sendSignedMsg(PORT, strangerKey, payload)
    assert.equal(resp.status, 403)
    const body = await resp.json()
    assert.match(body.error, /Not a world co-member/)
  })

  // ── UDP enforcement ───────────────────────────────────────────────────────

  test("UDP accepts co-member message", () => {
    const udpMsg = buildUdpMessage(memberKey, "chat", "udp hello")
    const result = handleUdpMessage(udpMsg, "127.0.0.1")
    assert.ok(result, "UDP message from co-member should be accepted")
  })

  test("UDP rejects non-co-member message", () => {
    const udpMsg = buildUdpMessage(strangerKey, "chat", "udp hello")
    const result = handleUdpMessage(udpMsg, "127.0.0.1")
    assert.equal(result, false, "UDP message from non-co-member should be dropped")
  })

  // ── Removed routes ────────────────────────────────────────────────────────

  test("/peer/inbox returns 404", async () => {
    const resp = await fetch(`http://[::1]:${PORT}/peer/inbox`)
    assert.equal(resp.status, 404)
  })

  test("/peer/peers returns 404", async () => {
    const resp = await fetch(`http://[::1]:${PORT}/peer/peers`)
    assert.equal(resp.status, 404)
  })

  test("/peer/announce returns 404", async () => {
    const resp = await fetch(`http://[::1]:${PORT}/peer/announce`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
    assert.equal(resp.status, 404)
  })

  test("/peer/ping still works (public)", async () => {
    const resp = await fetch(`http://[::1]:${PORT}/peer/ping`)
    assert.equal(resp.status, 200)
    const body = await resp.json()
    assert.ok(body.ok)
  })
})
