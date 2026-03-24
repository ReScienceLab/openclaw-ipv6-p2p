import { test } from "node:test"
import assert from "node:assert/strict"
import Fastify from "fastify"

const nacl = (await import("tweetnacl")).default

const {
  registerAgentRoutes,
  AgentDb,
  PROTOCOL_VERSION,
  agentIdFromPublicKey,
  signWithDomainSeparator,
  DOMAIN_SEPARATORS,
  toPublicKeyMultibase,
} = await import("../packages/agent-world-sdk/dist/index.js")

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

function makeProof(secretKey, signable) {
  const header = JSON.stringify({ alg: "EdDSA", kid: "#identity" })
  return {
    protected: Buffer.from(header).toString("base64url"),
    signature: signWithDomainSeparator(
      DOMAIN_SEPARATORS.KEY_ROTATION,
      signable,
      secretKey
    ),
  }
}

function makeSignedMessage(identity, overrides = {}) {
  const payload = {
    from: identity.agentId,
    publicKey: identity.pubB64,
    event: "chat",
    content: { text: "hello" },
    timestamp: Date.now(),
    ...overrides,
  }

  return {
    ...payload,
    signature: signWithDomainSeparator(
      DOMAIN_SEPARATORS.MESSAGE,
      payload,
      identity.secretKey
    ),
  }
}

function makeApp(t, opts = {}) {
  const fastify = Fastify({ logger: false })
  t.after(async () => {
    await fastify.close()
  })

  const agentDb = new AgentDb()
  registerAgentRoutes(fastify, {
    identity: makeIdentity(),
    agentDb,
    ...opts,
  })

  return { fastify, agentDb }
}

test("sdk /peer/key-rotation rejects mismatched newAgentId binding with stable 400 error", async (t) => {
  const { fastify } = makeApp(t)

  const oldKey = makeIdentity()
  const newKey = makeIdentity()
  const otherNewKey = makeIdentity()
  const timestamp = Date.now()
  const signable = {
    agentId: oldKey.agentId,
    oldPublicKey: oldKey.pubB64,
    newPublicKey: newKey.pubB64,
    timestamp,
  }

  const response = await fastify.inject({
    method: "POST",
    url: "/peer/key-rotation",
    headers: { "content-type": "application/json" },
    payload: {
      type: "agentworld-identity-rotation",
      version: PROTOCOL_VERSION,
      oldAgentId: oldKey.agentId,
      newAgentId: otherNewKey.agentId,
      oldIdentity: {
        agentId: oldKey.agentId,
        kid: "#identity",
        publicKeyMultibase: toPublicKeyMultibase(oldKey.pubB64),
      },
      newIdentity: {
        agentId: otherNewKey.agentId,
        kid: "#identity",
        publicKeyMultibase: toPublicKeyMultibase(newKey.pubB64),
      },
      timestamp,
      proofs: {
        signedByOld: makeProof(oldKey.secretKey, signable),
        signedByNew: makeProof(newKey.secretKey, signable),
      },
    },
  })

  assert.equal(response.statusCode, 400)
  assert.deepEqual(response.json(), {
    error: "newAgentId does not match newPublicKey",
  })
})

test("sdk /peer/key-rotation accepts correctly bound rotations and persists the new key", async (t) => {
  const { fastify, agentDb } = makeApp(t)

  const oldKey = makeIdentity()
  const newKey = makeIdentity()
  const timestamp = Date.now()
  const signable = {
    agentId: oldKey.agentId,
    oldPublicKey: oldKey.pubB64,
    newPublicKey: newKey.pubB64,
    timestamp,
  }

  const response = await fastify.inject({
    method: "POST",
    url: "/peer/key-rotation",
    headers: { "content-type": "application/json" },
    payload: {
      type: "agentworld-identity-rotation",
      version: PROTOCOL_VERSION,
      oldAgentId: oldKey.agentId,
      newAgentId: newKey.agentId,
      oldIdentity: {
        agentId: oldKey.agentId,
        kid: "#identity",
        publicKeyMultibase: toPublicKeyMultibase(oldKey.pubB64),
      },
      newIdentity: {
        agentId: newKey.agentId,
        kid: "#identity",
        publicKeyMultibase: toPublicKeyMultibase(newKey.pubB64),
      },
      timestamp,
      proofs: {
        signedByOld: makeProof(oldKey.secretKey, signable),
        signedByNew: makeProof(newKey.secretKey, signable),
      },
    },
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { ok: true })
  assert.equal(agentDb.get(oldKey.agentId)?.publicKey, newKey.pubB64)
})

test("sdk /peer/message returns the callback response body on the happy path", async (t) => {
  const sender = makeIdentity()
  const { fastify, agentDb } = makeApp(t, {
    onMessage: async (_agentId, event, content, reply) => {
      reply({
        ok: true,
        event,
        echoedContent: content,
      })
    },
  })

  const response = await fastify.inject({
    method: "POST",
    url: "/peer/message",
    headers: { "content-type": "application/json" },
    payload: makeSignedMessage(sender),
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), {
    ok: true,
    event: "chat",
    echoedContent: { text: "hello" },
  })
  assert.equal(agentDb.get(sender.agentId)?.publicKey, sender.pubB64)
})

test("sdk /peer/message preserves callback error replies", async (t) => {
  const sender = makeIdentity()
  const { fastify } = makeApp(t, {
    onMessage: async (_agentId, _event, _content, reply) => {
      reply({ error: "custom failure" }, 422)
    },
  })

  const response = await fastify.inject({
    method: "POST",
    url: "/peer/message",
    headers: { "content-type": "application/json" },
    payload: makeSignedMessage(sender, {
      event: "fail",
      content: { reason: "test" },
    }),
  })

  assert.equal(response.statusCode, 422)
  assert.deepEqual(response.json(), {
    error: "custom failure",
  })
})
