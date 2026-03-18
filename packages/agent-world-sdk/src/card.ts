/**
 * AgentWorld v0.2 Agent Card builder.
 *
 * Builds and JWS-signs a standard A2A-compatible Agent Card with an
 * `extensions.agentworld` block. The card is served at /.well-known/agent.json.
 *
 * Signing uses jose FlattenedSign (EdDSA/Ed25519). The `payload` field is
 * omitted from the stored signature entry — the card body itself is the
 * signed payload.
 */
import { FlattenedSign } from "jose"
import { createPrivateKey } from "node:crypto"
import { canonicalize } from "./crypto.js"
import { deriveDidKey, toPublicKeyMultibase } from "./identity.js"
import { PROTOCOL_VERSION } from "./version.js"
import type { Identity } from "./types.js"

// PKCS8 DER header for an Ed25519 32-byte seed (RFC 8410)
const PKCS8_ED25519_HEADER = Buffer.from("302e020100300506032b657004220420", "hex")

function toNodePrivateKey(secretKey: Uint8Array) {
  const seed = Buffer.from(secretKey.subarray(0, 32))
  const der = Buffer.concat([PKCS8_ED25519_HEADER, seed])
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" })
}

export interface AgentCardOpts {
  /** Human-readable agent name */
  name: string
  description?: string
  /** Canonical public URL of this card, e.g. https://gateway.example.com/.well-known/agent.json */
  cardUrl: string
  /** A2A JSON-RPC endpoint URL (optional) */
  rpcUrl?: string
  /** AgentWorld profiles to declare. Defaults to ["core/v0.2"] */
  profiles?: string[]
  /** Conformance node class. Defaults to "CoreNode" */
  nodeClass?: string
  /** Capabilities advertised in conformance block. Defaults to standard core/v0.2 set. */
  capabilities?: string[]
}

/**
 * Build and JWS-sign an AgentWorld v0.2 Agent Card.
 *
 * Returns the canonical JSON string that MUST be served verbatim as
 * `application/json`. The JWS signature covers
 * `JSON.stringify(canonicalize(cardWithoutSignatures))`, so verification
 * requires the verifier to strip the `signatures` field, re-canonicalize,
 * and attach the result as the JWS payload.
 */
export async function buildSignedAgentCard(
  opts: AgentCardOpts,
  identity: Identity
): Promise<string> {
  const profiles = opts.profiles ?? ["core/v0.2"]
  const nodeClass = opts.nodeClass ?? "CoreNode"
  const did = deriveDidKey(identity.pubB64)
  const publicKeyMultibase = toPublicKeyMultibase(identity.pubB64)

  const card: Record<string, unknown> = {
    id: opts.cardUrl,
    name: opts.name,
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.rpcUrl ? { a2a: { rpcUrl: opts.rpcUrl } } : {}),
    extensions: {
      agentworld: {
        version: PROTOCOL_VERSION,
        agentId: identity.agentId,
        identityMode: "direct",
        identity: {
          did,
          kid: "#identity",
          alg: "Ed25519",
          publicKeyMultibase,
        },
        requestSigning: {
          headers: [
            "X-AgentWorld-Version",
            "X-AgentWorld-From",
            "X-AgentWorld-KeyId",
            "X-AgentWorld-Timestamp",
            "Content-Digest",
            "X-AgentWorld-Signature",
          ],
        },
        profiles,
        conformance: {
          nodeClass,
          profiles: profiles.map((id) => ({ id, required: id === "core/v0.2" })),
          capabilities: opts.capabilities ?? [
            "signed-card-jws",
            "signed-http-requests",
            "signed-http-responses",
            "tofu-key-binding",
          ],
        },
      },
    },
  }

  // Sign the card body (without the signatures field) using FlattenedSign (EdDSA)
  const payload = Buffer.from(JSON.stringify(canonicalize(card)), "utf8")
  const privateKey = toNodePrivateKey(identity.secretKey)

  const jws = await new FlattenedSign(payload)
    .setProtectedHeader({ alg: "EdDSA", kid: "#identity" })
    .sign(privateKey)

  // Return the signed card as a canonical JSON string.
  // Serving this string verbatim ensures the bytes on the wire exactly match
  // what was signed, making verification unambiguous.
  const signedCard = { ...canonicalize(card) as object, signatures: [{ protected: jws.protected, signature: jws.signature }] }
  return JSON.stringify(canonicalize(signedCard))
}
