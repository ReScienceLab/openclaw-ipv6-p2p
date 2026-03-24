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

describe("Gateway /worlds/:worldId", () => {
  let tmpDir
  let app
  let stop

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-world-record-"))
    ;({ app, stop } = await createGatewayApp({ dataDir: tmpDir }))
  })

  after(async () => {
    await stop()
    fs.rmSync(tmpDir, { recursive: true })
  })

  async function announce(kp, worldId) {
    const payload = {
      from: kp.agentId,
      publicKey: kp.publicKey,
      alias: `World ${worldId}`,
      endpoints: [{ transport: "tcp", address: "10.0.0.1", port: 8099, priority: 1 }],
      capabilities: [`world:${worldId}`],
      timestamp: Date.now(),
    }
    const signature = signWithDomainSeparator(DOMAIN_SEPARATORS.ANNOUNCE, payload, kp.secretKey)
    return app.inject({
      method: "POST",
      url: "/agents",
      payload: { ...payload, signature },
    })
  }

  it("GET /worlds/:worldId returns 404 for unknown world", async () => {
    const resp = await app.inject({ method: "GET", url: "/worlds/nonexistent" })
    assert.equal(resp.statusCode, 404)
  })

  it("GET /worlds/:worldId includes publicKey after announce", async () => {
    const kp = makeKeypair()
    const worldId = "pixel-city"

    const annResp = await announce(kp, worldId)
    assert.equal(annResp.statusCode, 200, `announce failed: ${annResp.body}`)

    const resp = await app.inject({ method: "GET", url: `/worlds/${worldId}` })
    assert.equal(resp.statusCode, 200)

    const body = JSON.parse(resp.body)
    assert.equal(body.worldId, worldId)
    assert.equal(body.publicKey, kp.publicKey, "publicKey must be present in /worlds/:worldId response")
    assert.equal(body.agentId, kp.agentId)
  })

  it("GET /worlds/:worldId publicKey matches the announcing agent", async () => {
    const kp1 = makeKeypair()
    const kp2 = makeKeypair()

    await announce(kp1, "arena-alpha")
    await announce(kp2, "arena-beta")

    const r1 = JSON.parse((await app.inject({ method: "GET", url: "/worlds/arena-alpha" })).body)
    const r2 = JSON.parse((await app.inject({ method: "GET", url: "/worlds/arena-beta" })).body)

    assert.equal(r1.publicKey, kp1.publicKey)
    assert.equal(r2.publicKey, kp2.publicKey)
    assert.notEqual(r1.publicKey, r2.publicKey)
  })

  it("DELETE /worlds/:worldId returns 404 for unknown world", async () => {
    const resp = await app.inject({ method: "DELETE", url: "/worlds/nonexistent-delete" })
    assert.equal(resp.statusCode, 404)
  })

  it("DELETE /worlds/:worldId removes a known world", async () => {
    const kp = makeKeypair()
    const worldId = "delete-me"

    await announce(kp, worldId)
    const before = await app.inject({ method: "GET", url: `/worlds/${worldId}` })
    assert.equal(before.statusCode, 200)

    const del = await app.inject({ method: "DELETE", url: `/worlds/${worldId}` })
    assert.equal(del.statusCode, 200)
    const body = JSON.parse(del.body)
    assert.equal(body.ok, true)
    assert.equal(body.removed, 1)

    const after = await app.inject({ method: "GET", url: `/worlds/${worldId}` })
    assert.equal(after.statusCode, 404)
  })

  it("DELETE /worlds/:worldId returns 403 when GATEWAY_ADMIN_KEY is set and token is missing", async () => {
    const kp = makeKeypair()
    const worldId = "protected-world"
    await announce(kp, worldId)

    const prev = process.env.GATEWAY_ADMIN_KEY
    process.env.GATEWAY_ADMIN_KEY = "secret-test-key"
    try {
      const resp = await app.inject({ method: "DELETE", url: `/worlds/${worldId}` })
      assert.equal(resp.statusCode, 403)
    } finally {
      if (prev === undefined) delete process.env.GATEWAY_ADMIN_KEY
      else process.env.GATEWAY_ADMIN_KEY = prev
    }
  })

  it("DELETE /worlds/:worldId succeeds with correct GATEWAY_ADMIN_KEY bearer token", async () => {
    const kp = makeKeypair()
    const worldId = "protected-world-2"
    await announce(kp, worldId)

    const prev = process.env.GATEWAY_ADMIN_KEY
    process.env.GATEWAY_ADMIN_KEY = "secret-test-key"
    try {
      const resp = await app.inject({
        method: "DELETE",
        url: `/worlds/${worldId}`,
        headers: { authorization: "Bearer secret-test-key" },
      })
      assert.equal(resp.statusCode, 200)
      const body = JSON.parse(resp.body)
      assert.equal(body.ok, true)
      assert.equal(body.removed, 1)
    } finally {
      if (prev === undefined) delete process.env.GATEWAY_ADMIN_KEY
      else process.env.GATEWAY_ADMIN_KEY = prev
    }
  })
})
