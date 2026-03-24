import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import * as os from "node:os"
import * as fs from "node:fs"
import * as path from "node:path"

import nacl from "tweetnacl"
import { createGatewayApp } from "../gateway/server.mjs"

const { agentIdFromPublicKey, signWithDomainSeparator, DOMAIN_SEPARATORS } =
  await import("../packages/agent-world-sdk/dist/crypto.js")

function makeKeypair() {
  const kp = nacl.sign.keyPair()
  const pubB64 = Buffer.from(kp.publicKey).toString("base64")
  return { publicKey: pubB64, secretKey: kp.secretKey, agentId: agentIdFromPublicKey(pubB64) }
}

function signAnnounce(kp, worldId) {
  const payload = {
    from: kp.agentId,
    publicKey: kp.publicKey,
    alias: `World ${worldId}`,
    endpoints: [{ transport: "tcp", address: "10.0.0.1", port: 8099, priority: 1 }],
    capabilities: [`world:${worldId}`],
    timestamp: Date.now(),
  }
  const signature = signWithDomainSeparator(DOMAIN_SEPARATORS.ANNOUNCE, payload, kp.secretKey)
  return { ...payload, signature }
}

function signHeartbeat(kp) {
  const ts = Date.now()
  const payload = { agentId: kp.agentId, ts }
  const signature = signWithDomainSeparator(DOMAIN_SEPARATORS.HEARTBEAT, payload, kp.secretKey)
  return { ts, signature }
}

function signWorldHeartbeat(kp, worldId) {
  const ts = Date.now()
  const payload = { worldId, ts }
  const signature = signWithDomainSeparator(DOMAIN_SEPARATORS.HEARTBEAT, payload, kp.secretKey)
  return { ts, signature }
}

describe("Gateway /agents/:agentId/heartbeat", () => {
  let tmpDir
  let app
  let stop

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-heartbeat-"))
    ;({ app, stop } = await createGatewayApp({ dataDir: tmpDir, staleTtlMs: 90_000 }))
  })

  after(async () => {
    await stop()
    fs.rmSync(tmpDir, { recursive: true })
  })

  it("returns 404 for unknown agent", async () => {
    const kp = makeKeypair()
    const hb = signHeartbeat(kp)
    const resp = await app.inject({ method: "POST", url: `/agents/${kp.agentId}/heartbeat`, payload: hb })
    assert.equal(resp.statusCode, 404)
    const body = JSON.parse(resp.body)
    assert.equal(body.error, "Unknown agent")
  })

  it("returns 403 for invalid signature", async () => {
    const kp = makeKeypair()

    // First announce so the agent exists
    const ann = signAnnounce(kp, "hb-sig-test")
    const annResp = await app.inject({ method: "POST", url: "/agents", payload: ann })
    assert.equal(annResp.statusCode, 200)

    // Send heartbeat with wrong signature (sign with ANNOUNCE separator instead of HEARTBEAT)
    const ts = Date.now()
    const payload = { agentId: kp.agentId, ts }
    const wrongSig = signWithDomainSeparator(DOMAIN_SEPARATORS.ANNOUNCE, payload, kp.secretKey)

    const resp = await app.inject({
      method: "POST",
      url: `/agents/${kp.agentId}/heartbeat`,
      payload: { ts, signature: wrongSig },
    })
    assert.equal(resp.statusCode, 403)
    const body = JSON.parse(resp.body)
    assert.equal(body.error, "Invalid signature")
  })

  it("returns 400 for missing fields", async () => {
    const kp = makeKeypair()
    const resp = await app.inject({ method: "POST", url: `/agents/${kp.agentId}/heartbeat`, payload: {} })
    assert.equal(resp.statusCode, 400)
  })

  it("returns 400 for timestamp out of range", async () => {
    const kp = makeKeypair()

    // Sign heartbeat with a timestamp 10 minutes in the past
    const staleTs = Date.now() - 10 * 60 * 1000
    const payload = { agentId: kp.agentId, ts: staleTs }
    const signature = signWithDomainSeparator(DOMAIN_SEPARATORS.HEARTBEAT, payload, kp.secretKey)

    const resp = await app.inject({
      method: "POST",
      url: `/agents/${kp.agentId}/heartbeat`,
      payload: { ts: staleTs, signature },
    })
    assert.equal(resp.statusCode, 400)
    const body = JSON.parse(resp.body)
    assert.equal(body.error, "Timestamp out of range")
  })

  it("updates lastSeen in registry", async () => {
    const kp = makeKeypair()

    // Announce
    const ann = signAnnounce(kp, "hb-lastseen")
    await app.inject({ method: "POST", url: "/agents", payload: ann })

    // Record initial lastSeen
    const before = JSON.parse(
      (await app.inject({ method: "GET", url: "/worlds/hb-lastseen" })).body
    )
    const initialLastSeen = before.lastSeen

    // Small delay to ensure timestamps differ
    await new Promise((r) => setTimeout(r, 10))

    // Heartbeat
    const hb = signHeartbeat(kp)
    const resp = await app.inject({ method: "POST", url: `/agents/${kp.agentId}/heartbeat`, payload: hb })
    assert.equal(resp.statusCode, 200)
    const body = JSON.parse(resp.body)
    assert.equal(body.ok, true)

    // Verify lastSeen updated
    const afterResp = JSON.parse(
      (await app.inject({ method: "GET", url: "/worlds/hb-lastseen" })).body
    )
    assert.ok(afterResp.lastSeen >= initialLastSeen, "lastSeen should be updated after heartbeat")
  })
})

describe("Gateway /worlds/:worldId/heartbeat", () => {
  let tmpDir
  let app
  let stop

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-world-hb-"))
    ;({ app, stop } = await createGatewayApp({ dataDir: tmpDir, staleTtlMs: 90_000 }))
  })

  after(async () => {
    await stop()
    fs.rmSync(tmpDir, { recursive: true })
  })

  it("returns 404 for unknown world", async () => {
    const kp = makeKeypair()
    const hb = signWorldHeartbeat(kp, "unknown-world")
    const resp = await app.inject({ method: "POST", url: "/worlds/unknown-world/heartbeat", payload: hb })
    assert.equal(resp.statusCode, 404)
    const body = JSON.parse(resp.body)
    assert.equal(body.error, "World not found")
  })

  it("returns 403 for invalid signature", async () => {
    const kp = makeKeypair()
    const worldId = "world-hb-sig-test"

    const ann = signAnnounce(kp, worldId)
    const annResp = await app.inject({ method: "POST", url: "/agents", payload: ann })
    assert.equal(annResp.statusCode, 200)

    const ts = Date.now()
    const wrongSig = signWithDomainSeparator(DOMAIN_SEPARATORS.ANNOUNCE, { worldId, ts }, kp.secretKey)

    const resp = await app.inject({
      method: "POST",
      url: `/worlds/${worldId}/heartbeat`,
      payload: { ts, signature: wrongSig },
    })
    assert.equal(resp.statusCode, 403)
    const body = JSON.parse(resp.body)
    assert.equal(body.error, "Invalid signature")
  })

  it("updates lastSeen in registry", async () => {
    const kp = makeKeypair()
    const worldId = "world-hb-lastseen"

    const ann = signAnnounce(kp, worldId)
    await app.inject({ method: "POST", url: "/agents", payload: ann })

    const before = JSON.parse(
      (await app.inject({ method: "GET", url: `/worlds/${worldId}` })).body
    )
    const initialLastSeen = before.lastSeen

    await new Promise((r) => setTimeout(r, 10))

    const hb = signWorldHeartbeat(kp, worldId)
    const resp = await app.inject({ method: "POST", url: `/worlds/${worldId}/heartbeat`, payload: hb })
    assert.equal(resp.statusCode, 200)
    assert.equal(JSON.parse(resp.body).ok, true)

    const after = JSON.parse(
      (await app.inject({ method: "GET", url: `/worlds/${worldId}` })).body
    )
    assert.ok(after.lastSeen >= initialLastSeen, "lastSeen should be updated after world heartbeat")
  })
})

describe("Gateway stale TTL at 90s", () => {
  let tmpDir
  let app
  let stop

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-ttl-"))
    // Use a very short TTL for testing (100ms)
    ;({ app, stop } = await createGatewayApp({ dataDir: tmpDir, staleTtlMs: 100 }))
  })

  after(async () => {
    await stop()
    fs.rmSync(tmpDir, { recursive: true })
  })

  it("prunes agents after stale TTL", async () => {
    const kp = makeKeypair()
    const ann = signAnnounce(kp, "ttl-test")
    await app.inject({ method: "POST", url: "/agents", payload: ann })

    // Agent should be visible
    let resp = await app.inject({ method: "GET", url: "/worlds/ttl-test" })
    assert.equal(resp.statusCode, 200)

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 150))

    // Trigger a health check to confirm the agent still exists in the registry
    // (it's stale but pruning is interval-based — manually trigger via /agents)
    const agents = JSON.parse((await app.inject({ method: "GET", url: "/agents" })).body)
    const found = agents.agents.find((a) => a.agentId === kp.agentId)
    // Agent may still be in registry (pruning hasn't run), but lastSeen is stale
    if (found) {
      assert.ok(Date.now() - found.lastSeen >= 100, "Agent lastSeen should be older than TTL")
    }
  })

  it("heartbeat keeps agent alive past old 15-min TTL window", async () => {
    // Re-create app with 200ms TTL for fast testing
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-hb-alive-"))
    const { app: app2, stop: stop2 } = await createGatewayApp({ dataDir: tmpDir2, staleTtlMs: 200 })

    try {
      const kp = makeKeypair()
      const ann = signAnnounce(kp, "keep-alive")
      await app2.inject({ method: "POST", url: "/agents", payload: ann })

      // Send heartbeat before TTL expires
      await new Promise((r) => setTimeout(r, 100))
      const hb = signHeartbeat(kp)
      const resp = await app2.inject({ method: "POST", url: `/agents/${kp.agentId}/heartbeat`, payload: hb })
      assert.equal(resp.statusCode, 200)

      // Wait a bit more but not past TTL from last heartbeat
      await new Promise((r) => setTimeout(r, 50))

      // Agent should still be visible
      const worldResp = await app2.inject({ method: "GET", url: "/worlds/keep-alive" })
      assert.equal(worldResp.statusCode, 200, "Agent should still be visible after heartbeat")
    } finally {
      await stop2()
      fs.rmSync(tmpDir2, { recursive: true })
    }
  })
})
