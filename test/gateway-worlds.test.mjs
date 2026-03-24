import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import * as os from "node:os"
import * as fs from "node:fs"
import * as path from "node:path"

import { createGatewayApp } from "../gateway/server.mjs"

describe("Gateway GET /worlds", () => {
  let tmpDir, app, start, stop

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-worlds-"))
    // Seed registry with a world agent so /worlds has data after loadRegistry()
    const registry = {
      version: 1,
      savedAt: Date.now(),
      agents: {
        "aw:sha256:aaaa": {
          agentId: "aw:sha256:aaaa",
          publicKey: "dGVzdA==",
          alias: "Test World",
          endpoints: [{ transport: "tcp", address: "10.0.0.1", port: 8099, priority: 1 }],
          capabilities: ["world:test-world"],
          lastSeen: Date.now(),
        },
      },
    }
    fs.writeFileSync(path.join(tmpDir, "registry.json"), JSON.stringify(registry))
    ;({ app, start, stop } = await createGatewayApp({
      dataDir: tmpDir,
      httpPort: 0,
      staleTtlMs: 60 * 60 * 1000,
    }))
    // start() calls loadRegistry() which reads the seeded file
    await start()
  })

  after(async () => {
    await stop()
    fs.rmSync(tmpDir, { recursive: true })
  })

  it("returns worlds with endpoints array", async () => {
    const resp = await app.inject({ method: "GET", url: "/worlds" })
    assert.equal(resp.statusCode, 200)

    const body = JSON.parse(resp.body)
    assert.ok(Array.isArray(body.worlds))
    assert.equal(body.worlds.length, 1)

    const world = body.worlds[0]
    assert.equal(world.worldId, "test-world")
    assert.equal(world.name, "Test World")
    assert.equal(world.reachable, true)
    assert.ok(Array.isArray(world.endpoints), "endpoints must be an array in /worlds response")
    assert.equal(world.endpoints.length, 1)
    assert.equal(world.endpoints[0].address, "10.0.0.1")
    assert.equal(world.endpoints[0].port, 8099)
  })

  it("endpoints array is always present even when empty", async () => {
    const resp = await app.inject({ method: "GET", url: "/worlds" })
    const body = JSON.parse(resp.body)
    for (const world of body.worlds) {
      assert.ok(Array.isArray(world.endpoints), `world ${world.worldId} must have endpoints array`)
    }
  })

  it("GET /docs/json returns auto-generated OpenAPI spec with all routes", async () => {
    const resp = await app.inject({ method: "GET", url: "/docs/json" })
    assert.equal(resp.statusCode, 200)

    const spec = JSON.parse(resp.body)
    assert.equal(spec.info.title, "AWN Gateway")
    assert.ok(spec.openapi.startsWith("3."))

    const paths = Object.keys(spec.paths).sort()
    assert.ok(paths.includes("/worlds"), "must include /worlds")
    assert.ok(paths.includes("/health"), "must include /health")
    assert.ok(paths.includes("/agents"), "must include /agents")
    assert.ok(paths.includes("/messages"), "must include /messages")

    const schemas = Object.keys(spec.components?.schemas ?? {}).sort()
    assert.ok(schemas.includes("WorldSummary"), "must include WorldSummary schema")
    assert.ok(schemas.includes("Endpoint"), "must include Endpoint schema")
    assert.ok(schemas.includes("PeerRecord"), "must include PeerRecord schema")

    for (const [route, schemaName] of [
      ["/agents", "AnnounceRequest"],
      ["/messages", "SignedMessage"],
    ]) {
      const post = spec.paths[route]?.post
      assert.ok(post, `${route} POST must exist`)
      const ref = post.requestBody?.content?.["application/json"]?.schema?.$ref
      assert.ok(ref && ref.includes(schemaName), `${route} requestBody must reference ${schemaName}`)
    }
  })
})
