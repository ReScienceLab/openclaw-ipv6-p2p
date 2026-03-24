import { test } from "node:test"
import assert from "node:assert/strict"

import nacl from "tweetnacl"

import { agentIdFromPublicKey } from "../packages/agent-world-sdk/dist/crypto.js"
import { startGatewayAnnounce } from "../packages/agent-world-sdk/dist/gateway-announce.js"

function makeIdentity() {
  const keypair = nacl.sign.keyPair()
  const pubB64 = Buffer.from(keypair.publicKey).toString("base64")
  return {
    agentId: agentIdFromPublicKey(pubB64),
    pubB64,
    secretKey: keypair.secretKey,
    keypair,
  }
}

test("startGatewayAnnounce defaults to the local gateway HTTP port", async () => {
  const identity = makeIdentity()
  const fetchCalls = []
  const startupTimers = []

  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval

  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, init })
    return {
      ok: true,
      async json() {
        return { agents: [] }
      },
    }
  }

  globalThis.setTimeout = (callback) => {
    startupTimers.push(callback)
    return startupTimers.length
  }

  globalThis.clearTimeout = () => {}
  globalThis.setInterval = () => 1
  globalThis.clearInterval = () => {}

  try {
    const stop = await startGatewayAnnounce({
      identity,
      alias: "Local World",
      publicAddr: null,
      publicPort: 8099,
      capabilities: ["world"],
      agentDb: {
        size: 0,
        upsert() {},
      },
    })

    assert.equal(fetchCalls.length, 0)
    assert.equal(startupTimers.length, 1)

    startupTimers[0]()
    assert.equal(fetchCalls.length, 1)
    assert.equal(fetchCalls[0].url, "http://localhost:8100/agents")

    stop()
  } finally {
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
  }
})
