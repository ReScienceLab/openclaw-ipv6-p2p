import { test, describe, before, after } from "node:test"
import assert from "node:assert/strict"
import * as os from "node:os"
import * as fs from "node:fs"
import * as path from "node:path"

const nacl = (await import("tweetnacl")).default

import { createRequire } from "node:module"
const require = createRequire(import.meta.url)
const { version: PROTOCOL_VERSION } = require("../package.json")

const { startPeerServer, stopPeerServer } = await import("../dist/peer-server.js")
const { initDb } = await import("../dist/peer-db.js")
const { signMessage, agentIdFromPublicKey } = await import("../dist/identity.js")

function makeKeypair() {
  const kp = nacl.sign.keyPair()
  const pubB64 = Buffer.from(kp.publicKey).toString("base64")
  const privB64 = Buffer.from(kp.secretKey.slice(0, 32)).toString("base64")
  const agentId = agentIdFromPublicKey(pubB64)
  return { publicKey: pubB64, privateKey: privB64, agentId }
}

function sign(privB64, payload) {
  return signMessage(privB64, payload)
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

function makeProof(kid, privB64, signable) {
  const header = JSON.stringify({ alg: "EdDSA", kid })
  const protectedB64 = Buffer.from(header).toString("base64url")
  return { protected: protectedB64, signature: sign(privB64, signable) }
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
      signedByOld: makeProof("#identity", overrideProofOld ?? oldKey.privateKey, signable),
      signedByNew: makeProof("#identity", newKey.privateKey, signable),
    },
  }
}

describe("key rotation endpoint", () => {
  let port
  let tmpDir

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dap-kr-test-"))
    initDb(tmpDir)
    port = 18099
    await startPeerServer(port, { testMode: true })
  })

  after(async () => {
    await stopPeerServer()
    fs.rmSync(tmpDir, { recursive: true })
  })

  test("accepts valid v0.2 key rotation", async () => {
    const oldKey = makeKeypair()
    const newKey = makeKeypair()
    const resp = await fetch(`http://[::1]:${port}/peer/key-rotation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeRotationBody(oldKey, newKey)),
    })
    assert.equal(resp.status, 200)
    const json = await resp.json()
    assert.equal(json.ok, true)
  })

  test("rejects invalid old key proof", async () => {
    const oldKey = makeKeypair()
    const newKey = makeKeypair()
    const wrongKey = makeKeypair()
    const resp = await fetch(`http://[::1]:${port}/peer/key-rotation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeRotationBody(oldKey, newKey, wrongKey.privateKey)),
    })
    assert.equal(resp.status, 403)
  })

  test("rejects mismatched agentId (oldAgentId does not match oldPublicKey)", async () => {
    const oldKey = makeKeypair()
    const newKey = makeKeypair()
    const otherKey = makeKeypair()
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
        signedByOld: makeProof("#identity", oldKey.privateKey, signable),
        signedByNew: makeProof("#identity", newKey.privateKey, signable),
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

    // Establish TOFU for tofuKey by sending a message
    const msgPayload = {
      from: tofuKey.agentId,
      publicKey: tofuKey.publicKey,
      event: "ping",
      content: "hello",
      timestamp: Date.now(),
    }
    await fetch(`http://[::1]:${port}/peer/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...msgPayload, signature: sign(tofuKey.privateKey, msgPayload) }),
    })

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
        signedByOld: makeProof("#identity", attackerKey.privateKey, signable),
        signedByNew: makeProof("#identity", newKey.privateKey, signable),
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
