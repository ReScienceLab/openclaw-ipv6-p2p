import { after, afterEach, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const nacl = (await import("tweetnacl")).default
const { createWorldServer } = await import("../packages/agent-world-sdk/dist/world-server.js")
const {
  signHttpRequest,
  signWithDomainSeparator,
  DOMAIN_SEPARATORS,
  agentIdFromPublicKey,
} = await import("../packages/agent-world-sdk/dist/crypto.js")

const PORT = 18210

function makeKeypair() {
  const kp = nacl.sign.keyPair()
  const publicKey = Buffer.from(kp.publicKey).toString("base64")
  return { publicKey, secretKey: kp.secretKey }
}

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

async function createKnownNonMemberFixture(port = 29003) {
  const kp = makeKeypair()
  const agentId = agentIdFromPublicKey(kp.publicKey)
  const full = nacl.sign.keyPair.fromSeed(kp.secretKey.slice(0, 32))
  const endpoints = [
    { transport: "tcp", address: "127.0.0.1", port, priority: 1 },
  ]
  const announceResp = await announcePeer(
    agentId,
    kp.publicKey,
    full.secretKey,
    endpoints
  )
  return { agentId, endpoints, announceResp }
}

async function joinAgent(agentId, pubKey, secretKey, endpoints) {
  const content = JSON.stringify({ alias: "Watcher", endpoints })
  const payload = {
    from: agentId,
    publicKey: pubKey,
    event: "world.join",
    content,
    timestamp: Date.now(),
  }
  const signature = signWithDomainSeparator(
    DOMAIN_SEPARATORS.MESSAGE,
    payload,
    secretKey
  )
  const msg = { ...payload, signature }
  const body = JSON.stringify(msg)
  const host = `[::1]:${PORT}`
  const sdkIdentity = {
    agentId,
    pubB64: pubKey,
    secretKey,
    keypair: { publicKey: Buffer.from(pubKey, "base64"), secretKey },
  }
  const awHeaders = signHttpRequest(sdkIdentity, "POST", host, "/peer/message", body)
  const resp = await fetch(`http://${host}/peer/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...awHeaders },
    body,
  })
  return resp.json()
}

async function waitFor(assertReady, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (assertReady()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.fail("Timed out waiting for broadcast")
}

describe("World state broadcast delivery", () => {
  let tmpDir
  let server
  let originalFetch

  before(async () => {
    originalFetch = globalThis.fetch
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "world-state-broadcast-"))
    server = await createWorldServer(
      {
        worldId: "broadcast-test",
        worldName: "Broadcast Test",
        port: PORT,
        dataDir: tmpDir,
        isPublic: false,
        broadcastIntervalMs: 100,
      },
      {
        onJoin: async () => ({
          manifest: { name: "Broadcast Test" },
          state: {},
        }),
        onAction: async () => ({ ok: true }),
        onLeave: async () => {},
        getState: () => ({ tick: 1 }),
      }
    )
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  after(async () => {
    globalThis.fetch = originalFetch
    await server.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("creates a known non-member broadcast fixture via peer announce", async () => {
    const { agentId, announceResp } = await createKnownNonMemberFixture()

    assert.equal(Array.isArray(announceResp.peers), true)
    assert.equal(
      announceResp.peers.some(
        (peer) =>
          peer.agentId === agentId &&
          peer.endpoints.some((ep) => ep.port === 29003)
      ),
      true
    )
  })

  it("does not broadcast world.state to a known peer that never joined the world", async () => {
    const hits = []

    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const parsed = new URL(url)
      if (parsed.pathname === "/peer/message" && parsed.port === "29003") {
        hits.push({
          url,
          headers: init?.headers,
          body: JSON.parse(String(init?.body ?? "{}")),
        })
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return originalFetch(input, init)
    }

    const { agentId, announceResp } = await createKnownNonMemberFixture()

    assert.equal(Array.isArray(announceResp.peers), true)
    assert.equal(
      announceResp.peers.some((peer) => peer.agentId === agentId),
      true
    )

    await new Promise((resolve) => setTimeout(resolve, 350))

    assert.equal(hits.length, 0)
  })

  it("broadcasts world.state only to the active member's registered endpoints", async () => {
    const hits = []
    const endpointPorts = new Set([29001, 29002, 29003])

    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const parsed = new URL(url)
      if (parsed.pathname === "/peer/message" && endpointPorts.has(Number(parsed.port))) {
        hits.push({
          url,
          headers: init?.headers,
          body: JSON.parse(String(init?.body ?? "{}")),
        })
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return originalFetch(input, init)
    }

    const nonMember = await createKnownNonMemberFixture()

    const kp = makeKeypair()
    const agentId = agentIdFromPublicKey(kp.publicKey)
    const full = nacl.sign.keyPair.fromSeed(kp.secretKey.slice(0, 32))

    const joinResp = await joinAgent(agentId, kp.publicKey, full.secretKey, [
      { transport: "tcp", address: "127.0.0.1", port: 29001, priority: 1 },
      { transport: "tcp", address: "127.0.0.1", port: 29002, priority: 2 },
    ])

    assert.equal(joinResp.ok, true)

    await waitFor(() => hits.length >= 2)

    const worldStateHits = hits.filter((hit) => hit.body.event === "world.state")
    const hitPorts = worldStateHits.map((hit) => new URL(hit.url).port).sort()

    assert.deepEqual(hitPorts, ["29001", "29002"])
    assert.equal(hitPorts.includes(String(nonMember.endpoints[0].port)), false)

    for (const hit of worldStateHits) {
      const content = JSON.parse(hit.body.content)
      assert.equal(content.worldId, "broadcast-test")
      assert.equal(content.tick, 1)
    }
  })
})
