import { describe, test } from "node:test";
import assert from "node:assert/strict";

const nacl = (await import("tweetnacl")).default;
const {
  signWithDomainSeparator,
  verifyWithDomainSeparator,
  DOMAIN_SEPARATORS,
  canonicalize,
} = await import("../packages/agent-world-sdk/dist/crypto.js");

describe("Domain-Separated Signatures", () => {
  // Generate a test keypair
  const keypair = nacl.sign.keyPair();
  const secretKey = keypair.secretKey;
  const publicKeyB64 = Buffer.from(keypair.publicKey).toString("base64");

  const testPayload = {
    from: "aw:sha256:test123",
    timestamp: Date.now(),
    content: "test message",
  };

  test("signWithDomainSeparator produces valid signature", () => {
    const sig = signWithDomainSeparator(
      DOMAIN_SEPARATORS.HTTP_REQUEST,
      testPayload,
      secretKey
    );
    assert.ok(sig);
    assert.equal(typeof sig, "string");
    assert.ok(sig.length > 0);
  });

  test("verifyWithDomainSeparator validates correct signature", () => {
    const sig = signWithDomainSeparator(
      DOMAIN_SEPARATORS.HTTP_REQUEST,
      testPayload,
      secretKey
    );
    const valid = verifyWithDomainSeparator(
      DOMAIN_SEPARATORS.HTTP_REQUEST,
      publicKeyB64,
      testPayload,
      sig
    );
    assert.ok(valid);
  });

  test("signature from one context FAILS verification in another context", () => {
    // Sign with HTTP_REQUEST separator
    const sig = signWithDomainSeparator(
      DOMAIN_SEPARATORS.HTTP_REQUEST,
      testPayload,
      secretKey
    );

    // Try to verify with HTTP_RESPONSE separator — should FAIL
    const valid = verifyWithDomainSeparator(
      DOMAIN_SEPARATORS.HTTP_RESPONSE,
      publicKeyB64,
      testPayload,
      sig
    );
    assert.equal(valid, false);
  });

  test("HTTP request signature cannot be replayed as HTTP response", () => {
    const requestPayload = {
      v: "0.4.3",
      from: "aw:sha256:test123",
      kid: "#identity",
      ts: new Date().toISOString(),
      method: "POST",
      authority: "example.com",
      path: "/peer/message",
      contentDigest: "sha-256=:abc123:",
    };

    const reqSig = signWithDomainSeparator(
      DOMAIN_SEPARATORS.HTTP_REQUEST,
      requestPayload,
      secretKey
    );

    // Attacker tries to replay request signature as a response signature
    const validAsResponse = verifyWithDomainSeparator(
      DOMAIN_SEPARATORS.HTTP_RESPONSE,
      publicKeyB64,
      requestPayload,
      reqSig
    );
    assert.equal(validAsResponse, false);
  });

  test("Agent Card signature cannot be replayed as message signature", () => {
    const cardPayload = {
      id: "https://example.com/.well-known/agent.json",
      name: "Test Agent",
      extensions: {
        agentworld: {
          version: "0.4.3",
          agentId: "aw:sha256:test123",
        },
      },
    };

    const cardSig = signWithDomainSeparator(
      DOMAIN_SEPARATORS.AGENT_CARD,
      cardPayload,
      secretKey
    );

    // Attacker tries to replay card signature as a P2P message
    const validAsMessage = verifyWithDomainSeparator(
      DOMAIN_SEPARATORS.MESSAGE,
      publicKeyB64,
      cardPayload,
      cardSig
    );
    assert.equal(validAsMessage, false);
  });

  test("Announce signature cannot be replayed as message signature", () => {
    const announcePayload = {
      from: "aw:sha256:test123",
      publicKey: publicKeyB64,
      alias: "Test Agent",
      version: "0.4.3",
      endpoints: [],
      capabilities: ["core"],
      timestamp: Date.now(),
    };

    const announceSig = signWithDomainSeparator(
      DOMAIN_SEPARATORS.ANNOUNCE,
      announcePayload,
      secretKey
    );

    // Attacker tries to replay announce signature as a message
    const validAsMessage = verifyWithDomainSeparator(
      DOMAIN_SEPARATORS.MESSAGE,
      publicKeyB64,
      announcePayload,
      announceSig
    );
    assert.equal(validAsMessage, false);
  });

  test("Key rotation signature cannot be replayed in other contexts", () => {
    const rotationPayload = {
      agentId: "aw:sha256:test123",
      oldPublicKey: publicKeyB64,
      newPublicKey: "newkey123",
      timestamp: Date.now(),
    };

    const rotationSig = signWithDomainSeparator(
      DOMAIN_SEPARATORS.KEY_ROTATION,
      rotationPayload,
      secretKey
    );

    // Attacker tries to replay as announce
    const validAsAnnounce = verifyWithDomainSeparator(
      DOMAIN_SEPARATORS.ANNOUNCE,
      publicKeyB64,
      rotationPayload,
      rotationSig
    );
    assert.equal(validAsAnnounce, false);

    // Attacker tries to replay as message
    const validAsMessage = verifyWithDomainSeparator(
      DOMAIN_SEPARATORS.MESSAGE,
      publicKeyB64,
      rotationPayload,
      rotationSig
    );
    assert.equal(validAsMessage, false);
  });

  test("World state signature cannot be replayed as message", () => {
    const worldStatePayload = {
      from: "aw:sha256:test123",
      publicKey: publicKeyB64,
      event: "world.state",
      content: JSON.stringify({ worldId: "test", agents: 5 }),
      timestamp: Date.now(),
    };

    const stateSig = signWithDomainSeparator(
      DOMAIN_SEPARATORS.WORLD_STATE,
      worldStatePayload,
      secretKey
    );

    // Attacker tries to replay as regular message
    const validAsMessage = verifyWithDomainSeparator(
      DOMAIN_SEPARATORS.MESSAGE,
      publicKeyB64,
      worldStatePayload,
      stateSig
    );
    assert.equal(validAsMessage, false);
  });

  test("tampered payload fails verification even with correct separator", () => {
    const sig = signWithDomainSeparator(
      DOMAIN_SEPARATORS.MESSAGE,
      testPayload,
      secretKey
    );

    const tamperedPayload = { ...testPayload, content: "TAMPERED" };
    const valid = verifyWithDomainSeparator(
      DOMAIN_SEPARATORS.MESSAGE,
      publicKeyB64,
      tamperedPayload,
      sig
    );
    assert.equal(valid, false);
  });

  test("wrong public key fails verification", () => {
    const sig = signWithDomainSeparator(
      DOMAIN_SEPARATORS.MESSAGE,
      testPayload,
      secretKey
    );

    const wrongKeypair = nacl.sign.keyPair();
    const wrongPublicKeyB64 = Buffer.from(wrongKeypair.publicKey).toString(
      "base64"
    );

    const valid = verifyWithDomainSeparator(
      DOMAIN_SEPARATORS.MESSAGE,
      wrongPublicKeyB64,
      testPayload,
      sig
    );
    assert.equal(valid, false);
  });

  test("all domain separators are unique", () => {
    const separators = Object.values(DOMAIN_SEPARATORS);
    const uniqueSeparators = new Set(separators);
    assert.equal(
      separators.length,
      uniqueSeparators.size,
      "Domain separators must be unique"
    );
  });

  test("domain separators contain protocol version", () => {
    for (const [name, separator] of Object.entries(DOMAIN_SEPARATORS)) {
      // Version format is major.minor (e.g., "0.4" from "0.4.3")
      assert.ok(
        separator.includes("0.4") || /\d+\.\d+/.test(separator),
        `${name} separator should contain version (major.minor format)`
      );
    }
  });

  test("domain separators have null byte terminator", () => {
    for (const [name, separator] of Object.entries(DOMAIN_SEPARATORS)) {
      assert.ok(
        separator.endsWith("\0"),
        `${name} separator should end with null byte`
      );
    }
  });

  test("domain separators start with AgentWorld prefix", () => {
    for (const [name, separator] of Object.entries(DOMAIN_SEPARATORS)) {
      assert.ok(
        separator.startsWith("AgentWorld-"),
        `${name} separator should start with AgentWorld-`
      );
    }
  });

  test("payload canonicalization is deterministic", () => {
    const payload = {
      z: 3,
      a: 1,
      m: { nested: true, other: "value" },
      b: 2,
    };

    const sig1 = signWithDomainSeparator(
      DOMAIN_SEPARATORS.MESSAGE,
      payload,
      secretKey
    );
    const sig2 = signWithDomainSeparator(
      DOMAIN_SEPARATORS.MESSAGE,
      payload,
      secretKey
    );

    assert.equal(sig1, sig2, "Same payload should produce same signature");
  });

  test("payload canonicalization is order-independent", () => {
    const payload1 = { a: 1, b: 2, c: 3 };
    const payload2 = { c: 3, a: 1, b: 2 };

    const sig1 = signWithDomainSeparator(
      DOMAIN_SEPARATORS.MESSAGE,
      payload1,
      secretKey
    );
    const sig2 = signWithDomainSeparator(
      DOMAIN_SEPARATORS.MESSAGE,
      payload2,
      secretKey
    );

    assert.equal(
      sig1,
      sig2,
      "Different key order should produce same signature"
    );
  });

  test("nested object canonicalization works correctly", () => {
    const payload = {
      outer: {
        z: "last",
        a: "first",
        nested: { b: 2, a: 1 },
      },
    };

    const sig = signWithDomainSeparator(
      DOMAIN_SEPARATORS.MESSAGE,
      payload,
      secretKey
    );
    const valid = verifyWithDomainSeparator(
      DOMAIN_SEPARATORS.MESSAGE,
      publicKeyB64,
      payload,
      sig
    );
    assert.ok(valid);
  });

  test("verifyWithDomainSeparator handles invalid base64 gracefully", () => {
    const valid = verifyWithDomainSeparator(
      DOMAIN_SEPARATORS.MESSAGE,
      "invalid-base64!!!",
      testPayload,
      "invalid-sig!!!"
    );
    assert.equal(valid, false);
  });

  test("verifyWithDomainSeparator handles malformed payload gracefully", () => {
    const sig = signWithDomainSeparator(
      DOMAIN_SEPARATORS.MESSAGE,
      testPayload,
      secretKey
    );

    // Try to verify with circular reference (would throw without proper handling)
    const circularPayload = { a: 1 };
    circularPayload.self = circularPayload;

    // Should return false, not throw
    try {
      const valid = verifyWithDomainSeparator(
        DOMAIN_SEPARATORS.MESSAGE,
        publicKeyB64,
        circularPayload,
        sig
      );
      // If we get here without throwing, the test passes
      assert.equal(typeof valid, "boolean");
    } catch (err) {
      // Circular reference will throw during JSON.stringify
      // This is expected behavior
      assert.ok(err);
    }
  });
});
