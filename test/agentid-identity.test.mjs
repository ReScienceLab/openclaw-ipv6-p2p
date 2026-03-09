import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { agentIdFromPublicKey, deriveDidKey, generateIdentity, loadOrCreateIdentity } from "../dist/identity.js"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

describe("agentIdFromPublicKey", () => {
  it("returns a 32-character hex string", () => {
    const id = generateIdentity()
    const agentId = agentIdFromPublicKey(id.publicKey)
    assert.equal(agentId.length, 32)
    assert.match(agentId, /^[0-9a-f]{32}$/)
  })

  it("is deterministic for the same key", () => {
    const id = generateIdentity()
    const a = agentIdFromPublicKey(id.publicKey)
    const b = agentIdFromPublicKey(id.publicKey)
    assert.equal(a, b)
  })

  it("differs for different keys", () => {
    const id1 = generateIdentity()
    const id2 = generateIdentity()
    assert.notEqual(
      agentIdFromPublicKey(id1.publicKey),
      agentIdFromPublicKey(id2.publicKey)
    )
  })

  it("matches identity.agentId", () => {
    const id = generateIdentity()
    assert.equal(id.agentId, agentIdFromPublicKey(id.publicKey))
  })
})

describe("deriveDidKey", () => {
  it("returns did:key:z... format", () => {
    const id = generateIdentity()
    const did = deriveDidKey(id.publicKey)
    assert.ok(did.startsWith("did:key:z"))
  })

  it("is deterministic", () => {
    const id = generateIdentity()
    assert.equal(deriveDidKey(id.publicKey), deriveDidKey(id.publicKey))
  })
})

describe("generateIdentity", () => {
  it("includes agentId field", () => {
    const id = generateIdentity()
    assert.ok(id.agentId)
    assert.equal(id.agentId.length, 32)
  })

  it("does not include cgaIpv6 or yggIpv6 (transport-layer concerns)", () => {
    const id = generateIdentity()
    assert.equal(id.cgaIpv6, undefined)
    assert.equal(id.yggIpv6, undefined)
  })
})

describe("loadOrCreateIdentity", () => {
  it("adds agentId to a legacy identity file on load", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "declaw-test-"))
    const idFile = path.join(tmpDir, "identity.json")
    const legacy = {
      publicKey: "dGVzdHB1YmtleQ==",
      privateKey: "dGVzdHByaXZrZXk=",
    }
    fs.writeFileSync(idFile, JSON.stringify(legacy))

    const loaded = loadOrCreateIdentity(tmpDir)
    assert.ok(loaded.agentId)
    assert.equal(loaded.agentId.length, 32)

    const persisted = JSON.parse(fs.readFileSync(idFile, "utf-8"))
    assert.equal(persisted.agentId, loaded.agentId)

    fs.rmSync(tmpDir, { recursive: true })
  })

  it("does not overwrite existing agentId", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "declaw-test-"))
    const idFile = path.join(tmpDir, "identity.json")
    const existing = generateIdentity()
    fs.writeFileSync(idFile, JSON.stringify(existing))

    const loaded = loadOrCreateIdentity(tmpDir)
    assert.equal(loaded.agentId, existing.agentId)

    fs.rmSync(tmpDir, { recursive: true })
  })
})
