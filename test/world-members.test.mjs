/**
 * World-scoped member isolation — agents discover each other only through worlds.
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import * as os from "node:os"
import * as fs from "node:fs"
import * as path from "node:path"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const nacl = (await import("tweetnacl")).default

const { createWorldServer } = await import("../packages/agent-world-sdk/dist/world-server.js")

const PORT = 18200

function makeKeypair() {
  const kp = nacl.sign.keyPair()
  const pubB64 = Buffer.from(kp.publicKey).toString("base64")
  return { publicKey: pubB64, secretKey: kp.secretKey }
}

describe("World-scoped member discovery", () => {
  let tmpDir
  let server
  let signHttpRequest
  let signWithDomainSeparator
  let DOMAIN_SEPARATORS
  let agentIdFromPublicKey

  before(async () => {
    ;({ signHttpRequest, DOMAIN_SEPARATORS, signWithDomainSeparator, agentIdFromPublicKey } =
      await import("../packages/agent-world-sdk/dist/crypto.js"))
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "world-members-"))
    server = await createWorldServer(
      {
        worldId: "test-arena",
        worldName: "Test Arena",
        port: PORT,
        dataDir: tmpDir,
        isPublic: false,
        broadcastIntervalMs: 60_000,
      },
      {
        onJoin: async (_agentId, _data) => ({
          manifest: { name: "Test Arena" },
          state: {},
        }),
        onAction: async () => ({ ok: true }),
        onLeave: async () => {},
        getState: () => ({}),
      }
    )
  })

  after(async () => {
    await server.stop()
    fs.rmSync(tmpDir, { recursive: true })
  })

  async function announcePeer(agentId, pubKey, secretKey, endpoints) {
    const payload = {
      from: agentId,
      publicKey: pubKey,
      alias: "Known Peer",
      endpoints,
      capabilities: [],
      timestamp: Date.now(),
    }
    const signature = signWithDomainSeparator(
      DOMAIN_SEPARATORS.ANNOUNCE,
      payload,
      secretKey
    )
    const body = JSON.stringify({ ...payload, signature })
    const resp = await fetch(`http://[::1]:${PORT}/peer/announce`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    })
    return resp.json()
  }

  async function joinAgent(agentId, pubKey, secretKey, alias, endpoints) {
    const content = JSON.stringify({ alias, endpoints })
    const payload = {
      from: agentId,
      publicKey: pubKey,
      event: "world.join",
      content,
      timestamp: Date.now(),
    }
    const sig = signWithDomainSeparator(DOMAIN_SEPARATORS.MESSAGE, payload, secretKey)
    const msg = { ...payload, signature: sig }
    const body = JSON.stringify(msg)

    const host = `[::1]:${PORT}`
    const urlPath = "/peer/message"
    const sdkIdentity = {
      agentId,
      pubB64: pubKey,
      secretKey,
      keypair: { publicKey: Buffer.from(pubKey, "base64"), secretKey },
    }
    const awHeaders = signHttpRequest(sdkIdentity, "POST", host, urlPath, body)

    const resp = await fetch(`http://${host}${urlPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...awHeaders },
      body,
    })
    return resp.json()
  }

  it("world.join response includes members list", async () => {
    const kp1 = makeKeypair()
    const agentId1 = agentIdFromPublicKey(kp1.publicKey)
    const identity1 = {
      agentId: agentId1,
      publicKey: kp1.publicKey,
      privateKey: Buffer.from(kp1.secretKey.slice(0, 32)).toString("base64"),
    }
    const full1 = nacl.sign.keyPair.fromSeed(kp1.secretKey.slice(0, 32))

    const kp2 = makeKeypair()
    const agentId2 = agentIdFromPublicKey(kp2.publicKey)
    const full2 = nacl.sign.keyPair.fromSeed(kp2.secretKey.slice(0, 32))

    // Agent 1 joins — should get 0 members (nobody else yet)
    const resp1 = await joinAgent(
      agentId1, kp1.publicKey, full1.secretKey,
      "Agent1",
      [{ transport: "tcp", address: "10.0.0.1", port: 8099, priority: 1 }]
    )
    assert.ok(resp1.ok, "Agent 1 should join successfully")
    assert.ok(Array.isArray(resp1.members), "Join response should contain members array")
    assert.equal(resp1.members.length, 0, "First agent should see 0 members")

    // Agent 2 joins — should see Agent 1 in members
    const resp2 = await joinAgent(
      agentId2, kp2.publicKey, full2.secretKey,
      "Agent2",
      [{ transport: "tcp", address: "10.0.0.2", port: 8099, priority: 1 }]
    )
    assert.ok(resp2.ok, "Agent 2 should join successfully")
    assert.equal(resp2.members.length, 1, "Second agent should see 1 member")
    assert.equal(resp2.members[0].agentId, agentId1)
    assert.equal(resp2.members[0].alias, "Agent1")
    assert.ok(resp2.members[0].endpoints.length > 0, "Member should have endpoints")
    assert.equal(resp2.members[0].endpoints[0].address, "10.0.0.1")
  })

  it("world.join excludes discovered peers that never joined the world", async () => {
    const announced = makeKeypair()
    const announcedAgentId = agentIdFromPublicKey(announced.publicKey)
    const announcedFull = nacl.sign.keyPair.fromSeed(announced.secretKey.slice(0, 32))

    const announceResp = await announcePeer(
      announcedAgentId,
      announced.publicKey,
      announcedFull.secretKey,
      [{ transport: "tcp", address: "10.0.0.99", port: 8099, priority: 1 }]
    )

    assert.equal(
      announceResp.agents.some((peer) => peer.agentId === announcedAgentId),
      true
    )

    const joining = makeKeypair()
    const joiningAgentId = agentIdFromPublicKey(joining.publicKey)
    const joiningFull = nacl.sign.keyPair.fromSeed(joining.secretKey.slice(0, 32))

    const joinResp = await joinAgent(
      joiningAgentId,
      joining.publicKey,
      joiningFull.secretKey,
      "Joiner",
      [{ transport: "tcp", address: "10.0.0.10", port: 8099, priority: 1 }]
    )

    assert.ok(joinResp.ok, "Joined agent should join successfully")
    assert.equal(
      joinResp.members.some((member) => member.agentId === announcedAgentId),
      false
    )
  })

  it("/world/members requires authentication", async () => {
    const resp = await fetch(`http://[::1]:${PORT}/world/members`)
    assert.equal(resp.status, 403)
  })

  it("/world/members returns members for authenticated agent", async () => {
    const resp = await fetch(`http://[::1]:${PORT}/world/members`, {
      headers: { "X-AgentWorld-From": "aw:sha256:0000000000000000" },
    })
    // This agent is not in the world, should get 403
    assert.equal(resp.status, 403)
  })
})
