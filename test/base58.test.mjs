import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { base58Encode, deriveDidKey, toPublicKeyMultibase } from "../packages/agent-world-sdk/dist/identity.js"
import { base58Decode } from "../packages/agent-world-sdk/dist/peer-protocol.js"

const encodeCases = [
  { bytes: [0], encoded: "1" },
  { bytes: [0, 0], encoded: "11" },
  { bytes: [0, 1], encoded: "12" },
  { bytes: [1], encoded: "2" },
  { bytes: [1, 0], encoded: "5R" },
]

const decodeCases = [
  { encoded: "1", bytes: [0] },
  { encoded: "11", bytes: [0, 0] },
  { encoded: "12", bytes: [0, 1] },
  { encoded: "2", bytes: [1] },
  { encoded: "5R", bytes: [1, 0] },
]

const deterministicPublicKeyB64 = "iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w="
const deterministicDidKey = "did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX"
const deterministicPublicKeyMultibase = "z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX"

describe("base58Encode", () => {
  for (const { bytes, encoded } of encodeCases) {
    it(`encodes [${bytes.join(",")}] as ${encoded}`, () => {
      assert.equal(base58Encode(Buffer.from(bytes)), encoded)
    })
  }
})

describe("base58Decode", () => {
  for (const { encoded, bytes } of decodeCases) {
    it(`decodes ${encoded} as [${bytes.join(",")}]`, () => {
      assert.deepEqual(Array.from(base58Decode(encoded)), bytes)
    })
  }
})

describe("base58 round trips", () => {
  for (const { bytes, encoded } of encodeCases) {
    it(`round-trips [${bytes.join(",")}] byte-for-byte`, () => {
      assert.equal(encoded, base58Encode(Buffer.from(bytes)))
      assert.deepEqual(Array.from(base58Decode(encoded)), bytes)
    })
  }
})

describe("deriveDidKey", () => {
  it("returns the fixed DID for the deterministic fixture", () => {
    assert.equal(deriveDidKey(deterministicPublicKeyB64), deterministicDidKey)
  })
})

describe("toPublicKeyMultibase", () => {
  it("returns the fixed multibase value for the deterministic fixture", () => {
    assert.equal(toPublicKeyMultibase(deterministicPublicKeyB64), deterministicPublicKeyMultibase)
  })
})
