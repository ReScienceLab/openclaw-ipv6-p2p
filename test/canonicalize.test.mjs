import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, signMessage, verifySignature } from "../dist/identity.js";

describe("canonicalize", () => {
  it("sorts top-level keys", () => {
    const input = { z: 1, a: 2, m: 3 };
    assert.deepEqual(canonicalize(input), { a: 2, m: 3, z: 1 });
    assert.equal(
      JSON.stringify(canonicalize(input)),
      '{"a":2,"m":3,"z":1}'
    );
  });

  it("sorts nested object keys recursively", () => {
    const input = { b: { z: 1, a: 2 }, a: 1 };
    assert.equal(
      JSON.stringify(canonicalize(input)),
      '{"a":1,"b":{"a":2,"z":1}}'
    );
  });

  it("sorts keys inside arrays of objects", () => {
    const input = {
      agents: [
        { agentId: "aabbcc01", publicKey: "pk1", lastSeen: 100 },
        { lastSeen: 200, agentId: "aabbcc02", publicKey: "pk2" },
      ],
    };
    const result = JSON.stringify(canonicalize(input));
    // Both objects in array should have keys in alphabetical order
    assert.ok(result.includes('"agentId":"aabbcc01","lastSeen":100,"publicKey":"pk1"'));
    assert.ok(result.includes('"agentId":"aabbcc02","lastSeen":200,"publicKey":"pk2"'));
  });

  it("handles primitives and null", () => {
    assert.equal(canonicalize(42), 42);
    assert.equal(canonicalize("hello"), "hello");
    assert.equal(canonicalize(null), null);
    assert.equal(canonicalize(true), true);
  });

  it("produces identical serialization regardless of key insertion order", () => {
    const a = { from: "aabbcc01", publicKey: "pk", timestamp: 1, agents: [{ agentId: "x", lastSeen: 1 }] };
    const b = { agents: [{ lastSeen: 1, agentId: "x" }], timestamp: 1, publicKey: "pk", from: "aabbcc01" };
    assert.equal(
      JSON.stringify(canonicalize(a)),
      JSON.stringify(canonicalize(b))
    );
  });
});

const nacl = (await import("tweetnacl")).default;

describe("signMessage + verifySignature with nested data", () => {
  const keypair = nacl.sign.keyPair();
  const pubB64 = Buffer.from(keypair.publicKey).toString("base64");
  const privB64 = Buffer.from(keypair.secretKey.slice(0, 32)).toString("base64");

  it("verifies signature on flat object", () => {
    const data = { from: "aabbcc01", publicKey: pubB64, timestamp: Date.now() };
    const sig = signMessage(privB64, data);
    assert.equal(verifySignature(pubB64, data, sig), true);
  });

  it("verifies signature on object with nested agents array", () => {
    const data = {
      from: "aabbcc01",
      publicKey: pubB64,
      timestamp: Date.now(),
      agents: [
        { agentId: "aabbcc02", publicKey: "pk2", lastSeen: 100 },
        { agentId: "aabbcc03", publicKey: "pk3", lastSeen: 200 },
      ],
    };
    const sig = signMessage(privB64, data);
    assert.equal(verifySignature(pubB64, data, sig), true);
  });

  it("verifies even when nested key order differs", () => {
    const dataSign = {
      from: "aabbcc01",
      publicKey: pubB64,
      timestamp: 999,
      agents: [{ agentId: "aabbcc02", publicKey: "pk2", lastSeen: 100 }],
    };
    const sig = signMessage(privB64, dataSign);

    // Verify with different key insertion order
    const dataVerify = {
      agents: [{ lastSeen: 100, agentId: "aabbcc02", publicKey: "pk2" }],
      timestamp: 999,
      publicKey: pubB64,
      from: "aabbcc01",
    };
    assert.equal(verifySignature(pubB64, dataVerify, sig), true);
  });

  it("rejects tampered nested field", () => {
    const data = {
      from: "aabbcc01",
      publicKey: pubB64,
      timestamp: 999,
      agents: [{ agentId: "aabbcc02", publicKey: "pk2", lastSeen: 100 }],
    };
    const sig = signMessage(privB64, data);

    const tampered = {
      ...data,
      agents: [{ agentId: "evil0000", publicKey: "pk2", lastSeen: 100 }],
    };
    assert.equal(verifySignature(pubB64, tampered, sig), false);
  });
});
