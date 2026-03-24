import { test, describe, before, after } from "node:test"
import assert from "node:assert/strict"
import * as os from "node:os"
import * as fs from "node:fs"
import * as path from "node:path"

const nacl = (await import("tweetnacl")).default

import { createRequire } from "node:module"
const require = createRequire(import.meta.url)
const pkgVersion = require("../package.json").version
const PROTOCOL_VERSION = pkgVersion.split(".").slice(0, 2).join(".")

const { startAgentServer, stopAgentServer, addWorldMembers } = await import("../dist/agent-server.js")
const { initDb, getAgent } = await import("../dist/agent-db.js")
const { agentIdFromPublicKey, signWithDomainSeparator, DOMAIN_SEPARATORS, signHttpRequest, canonicalize } = await import("../dist/identity.js")

function makeKeypair() {
  const kp = nacl.sign.keyPair()
  const pubB64 = Buffer.from(kp.publicKey).toString("base64")
  const privB64 = Buffer.from(kp.secretKey.slice(0, 32)).toString("base64")
  const agentId = agentIdFromPublicKey(pubB64)
  return { publicKey: pubB64, privateKey: privB64, secretKey: kp.secretKey, agentId }
}

async function sendSignedMessage(port, key, payload) {
  const body = JSON.stringify(canonicalize(payload))
  const identity = { agentId: key.agentId, privateKey: key.privateKey, publicKey: key.publicKey }
  const awHeaders = signHttpRequest(identity, "POST", `[::1]:${port}`, "/peer/message", body)
  return fetch(`http://[::1]:${port}/peer/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...awHeaders },
    body,
  })
}

function signRotation(secretKey, payload) {
  return signWithDomainSeparator(DOMAIN_SEPARATORS.KEY_ROTATION, payload, secretKey)
}

function pubToMultibase(pubB64) {
  const pubBytes = Buffer.from(pubB64, "base64")
  const prefix = Buffer.from([0xed, 0x01])
  const prefixed = Buffer.concat([prefix, pubBytes])
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
  const digits = [0]
  for (const byte of prefixed) {
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
  for (let i = 0; i < prefixed.length && prefixed[i] === 0; i++) str += "1"
  for (let i = digits.length - 1; i >= 0; i--) str += ALPHABET[digits[i]]
  return `z${str}`
}

function makeProof(kid, secretKey, signable) {
  const header = JSON.stringify({ alg: "EdDSA", kid })
  const protectedB64 = Buffer.from(header).toString("base64url")
  return { protected: protectedB64, signature: signRotation(secretKey, signable) }
}

function makeRotationBody(oldKey, newKey, overrideProofOld) {
  const signable = {
    agentId: oldKey.agentId,
    oldPublicKey: oldKey.publicKey,
    newPublicKey: newKey.publicKey,
    timestamp: Date.now(),
  }
  return {
    type: "agentworld-identity-rotation",
    version: PROTOCOL_VERSION,
    oldAgentId: oldKey.agentId,
    newAgentId: newKey.agentId,
    oldIdentity: { agentId: oldKey.agentId, kid: "#identity", publicKeyMultibase: pubToMultibase(oldKey.publicKey) },
    newIdentity: { agentId: newKey.agentId, kid: "#identity", publicKeyMultibase: pubToMultibase(newKey.publicKey) },
    timestamp: signable.timestamp,
    proofs: {
      signedByOld: makeProof("#identity", overrideProofOld ?? oldKey.secretKey, signable),
      signedByNew: makeProof("#identity", newKey.secretKey, signable),
    },
  }
}

describe("key rotation endpoint", () => {
  let port
  let tmpDir

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "awn-kr-test-"))
    initDb(tmpDir)
    port = 18099
    await startAgentServer(port, { testMode: true })
  })

  after(async () => {
    await stopAgentServer()
    fs.rmSync(tmpDir, { recursive: true })
  })

  test("accepts valid key rotation from co-member", async () => {
    const oldKey = makeKeypair()
    const newKey = makeKeypair()
    addWorldMembers("test-world", [oldKey.agentId])
    const resp = await fetch(`http://[::1]:${port}/peer/key-rotation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeRotationBody(oldKey, newKey)),
    })
    assert.equal(resp.status, 200)
    const json = await resp.json()
    assert.equal(json.ok, true)
  })

  test("rejects key rotation from unknown agent", async () => {
    const oldKey = makeKeypair()
    const newKey = makeKeypair()
    const resp = await fetch(`http://[::1]:${port}/peer/key-rotation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeRotationBody(oldKey, newKey)),
    })
    assert.equal(resp.status, 403)
    const json = await resp.json()
    assert.match(json.error, /Unknown agent/)
  })

  test("rejects invalid old key proof", async () => {
    const oldKey = makeKeypair()
    const newKey = makeKeypair()
    const wrongKey = makeKeypair()
    const resp = await fetch(`http://[::1]:${port}/peer/key-rotation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeRotationBody(oldKey, newKey, wrongKey.secretKey)),
    })
    assert.equal(resp.status, 403)
  })

  test("rejects mismatched agentId (oldAgentId does not match oldPublicKey)", async () => {
    const oldKey = makeKeypair()
    const newKey = makeKeypair()
    const otherKey = makeKeypair()
    addWorldMembers("test-world", [otherKey.agentId])
    const signable = {
      agentId: otherKey.agentId,
      oldPublicKey: oldKey.publicKey,
      newPublicKey: newKey.publicKey,
      timestamp: Date.now(),
    }
    const body = {
      type: "agentworld-identity-rotation",
      version: PROTOCOL_VERSION,
      oldAgentId: otherKey.agentId,
      newAgentId: newKey.agentId,
      oldIdentity: { agentId: otherKey.agentId, kid: "#identity", publicKeyMultibase: pubToMultibase(oldKey.publicKey) },
      newIdentity: { agentId: newKey.agentId, kid: "#identity", publicKeyMultibase: pubToMultibase(newKey.publicKey) },
      timestamp: signable.timestamp,
      proofs: {
        signedByOld: makeProof("#identity", oldKey.secretKey, signable),
        signedByNew: makeProof("#identity", newKey.secretKey, signable),
      },
    }
    const resp = await fetch(`http://[::1]:${port}/peer/key-rotation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    assert.equal(resp.status, 400)
  })

  test("rejects missing required fields", async () => {
    const resp = await fetch(`http://[::1]:${port}/peer/key-rotation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "agentworld-identity-rotation", version: PROTOCOL_VERSION }),
    })
    assert.equal(resp.status, 400)
  })

  test("rejects mismatched rotated identity binding with stable 400 error", async () => {
    const oldKey = makeKeypair()
    const newKey = makeKeypair()
    const otherNewKey = makeKeypair()
    addWorldMembers("test-world", [oldKey.agentId])

    const signable = {
      agentId: oldKey.agentId,
      oldPublicKey: oldKey.publicKey,
      newPublicKey: newKey.publicKey,
      timestamp: Date.now(),
    }
    const body = {
      type: "agentworld-identity-rotation",
      version: PROTOCOL_VERSION,
      oldAgentId: oldKey.agentId,
      newAgentId: otherNewKey.agentId,
      oldIdentity: {
        agentId: oldKey.agentId,
        kid: "#identity",
        publicKeyMultibase: pubToMultibase(oldKey.publicKey),
      },
      newIdentity: {
        agentId: otherNewKey.agentId,
        kid: "#identity",
        publicKeyMultibase: pubToMultibase(newKey.publicKey),
      },
      timestamp: signable.timestamp,
      proofs: {
        signedByOld: makeProof("#identity", oldKey.secretKey, signable),
        signedByNew: makeProof("#identity", newKey.secretKey, signable),
      },
    }

    const resp = await fetch(`http://[::1]:${port}/peer/key-rotation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    assert.equal(resp.status, 400)
    assert.deepEqual(await resp.json(), {
      error: "newAgentId does not match newPublicKey",
    })
  })

  test("rejects mismatched rotated identity binding before mutating stored key state", async () => {
    const oldKey = makeKeypair()
    const attemptedNewKey = makeKeypair()
    const otherNewKey = makeKeypair()
    addWorldMembers("test-world", [oldKey.agentId])

    const validSeedResp = await sendSignedMessage(port, oldKey, {
      from: oldKey.agentId,
      publicKey: oldKey.publicKey,
      event: "ping",
      content: "seed tofu binding",
      timestamp: Date.now(),
      signature: signWithDomainSeparator(
        DOMAIN_SEPARATORS.MESSAGE,
        {
          from: oldKey.agentId,
          publicKey: oldKey.publicKey,
          event: "ping",
          content: "seed tofu binding",
          timestamp: Date.now(),
        },
        oldKey.secretKey
      ),
    })
    assert.equal(validSeedResp.status, 200)
    assert.equal(getAgent(oldKey.agentId)?.publicKey, oldKey.publicKey)

    const signable = {
      agentId: oldKey.agentId,
      oldPublicKey: oldKey.publicKey,
      newPublicKey: attemptedNewKey.publicKey,
      timestamp: Date.now(),
    }
    const body = {
      type: "agentworld-identity-rotation",
      version: PROTOCOL_VERSION,
      oldAgentId: oldKey.agentId,
      newAgentId: otherNewKey.agentId,
      oldIdentity: {
        agentId: oldKey.agentId,
        kid: "#identity",
        publicKeyMultibase: pubToMultibase(oldKey.publicKey),
      },
      newIdentity: {
        agentId: otherNewKey.agentId,
        kid: "#identity",
        publicKeyMultibase: pubToMultibase(attemptedNewKey.publicKey),
      },
      timestamp: signable.timestamp,
      proofs: {
        signedByOld: makeProof("#identity", oldKey.secretKey, signable),
        signedByNew: makeProof("#identity", attemptedNewKey.secretKey, signable),
      },
    }

    const resp = await fetch(`http://[::1]:${port}/peer/key-rotation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    assert.equal(resp.status, 400)
    assert.deepEqual(await resp.json(), {
      error: "newAgentId does not match newPublicKey",
    })
    assert.equal(getAgent(oldKey.agentId)?.publicKey, oldKey.publicKey)
  })

  test("rejects wrong type/version", async () => {
    const resp = await fetch(`http://[::1]:${port}/peer/key-rotation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "key-rotation", version: PROTOCOL_VERSION, oldAgentId: "x" }),
    })
    assert.equal(resp.status, 400)
  })

  test("rejects key-loss recovery — TOFU binding mismatch", async () => {
    const tofuKey = makeKeypair()
    const attackerKey = makeKeypair()
    const newKey = makeKeypair()

    // Register as co-member so message goes through, establishing TOFU
    addWorldMembers("test-world", [tofuKey.agentId])
    const msgPayload = {
      from: tofuKey.agentId,
      publicKey: tofuKey.publicKey,
      event: "ping",
      content: "hello",
      timestamp: Date.now(),
      signature: signWithDomainSeparator(DOMAIN_SEPARATORS.MESSAGE, { from: tofuKey.agentId, publicKey: tofuKey.publicKey, event: "ping", content: "hello", timestamp: Date.now() }, tofuKey.secretKey),
    }
    await sendSignedMessage(port, tofuKey, msgPayload)

    // Attacker claims tofuKey.agentId but provides attackerKey as oldPublicKey.
    // agentIdFromPublicKey(attackerKey) !== tofuKey.agentId → server rejects 400.
    const signable = {
      agentId: tofuKey.agentId,
      oldPublicKey: attackerKey.publicKey,
      newPublicKey: newKey.publicKey,
      timestamp: Date.now(),
    }
    const body = {
      type: "agentworld-identity-rotation",
      version: PROTOCOL_VERSION,
      oldAgentId: tofuKey.agentId,
      newAgentId: newKey.agentId,
      oldIdentity: {
        agentId: tofuKey.agentId,
        kid: "#identity",
        publicKeyMultibase: pubToMultibase(attackerKey.publicKey),
      },
      newIdentity: { agentId: newKey.agentId, kid: "#identity", publicKeyMultibase: pubToMultibase(newKey.publicKey) },
      timestamp: signable.timestamp,
      proofs: {
        signedByOld: makeProof("#identity", attackerKey.secretKey, signable),
        signedByNew: makeProof("#identity", newKey.secretKey, signable),
      },
    }
    const resp = await fetch(`http://[::1]:${port}/peer/key-rotation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    assert.equal(resp.status, 400)
  })
})
