import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import {
  agentIdFromPublicKey,
  canonicalize,
  verifySignature,
  verifyHttpRequestHeaders,
  signHttpResponse,
  DOMAIN_SEPARATORS,
  verifyWithDomainSeparator,
} from "./crypto.js";
import { PROTOCOL_VERSION } from "./version.js";
import { buildSignedAgentCard } from "./card.js";
import type { AgentCardOpts } from "./card.js";
import type { Identity, KeyRotationRequest } from "./types.js";
import type { PeerDb as PeerDbType } from "./peer-db.js";

export type { AgentCardOpts };

export interface PeerProtocolOpts {
  identity: Identity;
  peerDb: PeerDbType;
  /** Extra fields to include in /peer/ping response (evaluated on every request) */
  pingExtra?: Record<string, unknown> | (() => Record<string, unknown>);
  /** Called when a non-peer-protocol message arrives. Return reply body or null to skip. */
  onMessage?: (
    agentId: string,
    event: string,
    content: unknown,
    reply: (body: unknown, statusCode?: number) => void
  ) => Promise<void>;
  /** If provided, serve GET /.well-known/agent.json with a JWS-signed Agent Card */
  card?: AgentCardOpts;
}

/**
 * Register DAP peer protocol routes on a Fastify instance:
 *   GET  /peer/ping
 *   GET  /peer/peers
 *   POST /peer/announce
 *   POST /peer/message
 */
export function registerPeerRoutes(
  fastify: FastifyInstance,
  opts: PeerProtocolOpts
): void {
  const { identity, peerDb, pingExtra, onMessage, card } = opts;

  // Custom JSON parser that preserves the raw body string for digest verification.
  // The raw bytes are stored on req.rawBody so verifyHttpRequestHeaders can check
  // Content-Digest against exactly what the sender transmitted.
  fastify.decorateRequest("rawBody", "");
  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (req, body, done) => {
      try {
        (req as unknown as { rawBody: string }).rawBody = body as string;
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );

  // Sign all /peer/* JSON responses
  fastify.addHook("onSend", async (_req, reply, payload) => {
    if (typeof payload !== "string") return payload;
    const url = (_req.url ?? "").split("?")[0];
    if (!url.startsWith("/peer/")) return payload;
    const ct = reply.getHeader("content-type") as string | undefined;
    if (!ct || !ct.includes("application/json")) return payload;
    const hdrs = signHttpResponse(identity, reply.statusCode, payload);
    for (const [k, v] of Object.entries(hdrs)) reply.header(k, v);
    return payload;
  });

  // Agent Card endpoint (optional — only registered when card opts are provided)
  if (card) {
    let cachedCardJson: string | null = null;
    let cachedEtag: string | null = null;
    fastify.get("/.well-known/agent.json", async (_req, reply) => {
      if (!cachedCardJson) {
        cachedCardJson = await buildSignedAgentCard(card, identity);
        const hash = createHash("sha256")
          .update(cachedCardJson, "utf8")
          .digest("hex")
          .slice(0, 16);
        cachedEtag = `"${hash}"`;
      }
      reply.header("Content-Type", "application/json; charset=utf-8");
      reply.header("Cache-Control", "public, max-age=300");
      reply.header("ETag", cachedEtag!);
      reply.send(cachedCardJson);
    });
  }

  fastify.get("/peer/ping", async () => ({
    ok: true,
    ts: Date.now(),
    agentId: identity.agentId,
    ...(typeof pingExtra === "function" ? pingExtra() : pingExtra),
  }));

  fastify.get("/peer/peers", async () => ({
    peers: peerDb.getPeersForExchange(),
  }));

  fastify.post("/peer/announce", async (req, reply) => {
    const ann = req.body as Record<string, unknown>;
    if (!ann?.publicKey || !ann?.from) {
      return reply.code(400).send({ error: "Invalid announce" });
    }

    const awSig = req.headers["x-agentworld-signature"];
    if (awSig) {
      const rawBody = (req as unknown as { rawBody: string }).rawBody;
      const authority = (req.headers["host"] as string) ?? "localhost";
      const result = verifyHttpRequestHeaders(
        req.headers as Record<string, string>,
        req.method,
        req.url,
        authority,
        rawBody,
        ann.publicKey as string
      );
      if (!result.ok) return reply.code(403).send({ error: result.error });
      const headerFrom = req.headers["x-agentworld-from"] as string;
      if (headerFrom !== ann.from) {
        return reply.code(400).send({ error: "X-AgentWorld-From does not match body from" });
      }
    } else {
      const { signature, ...signable } = ann;
      if (
        !verifyWithDomainSeparator(
          DOMAIN_SEPARATORS.ANNOUNCE,
          ann.publicKey as string,
          signable,
          signature as string
        )
      ) {
        return reply.code(403).send({ error: "Invalid signature" });
      }
    }

    if (agentIdFromPublicKey(ann.publicKey as string) !== ann.from) {
      return reply
        .code(400)
        .send({ error: "agentId does not match publicKey" });
    }
    peerDb.upsert(ann.from as string, ann.publicKey as string, {
      alias: ann.alias as string,
      endpoints: ann.endpoints as [],
      capabilities: ann.capabilities as [],
    });
    return { peers: peerDb.getPeersForExchange() };
  });

  fastify.post("/peer/message", async (req, reply) => {
    const msg = req.body as Record<string, unknown>;
    if (!msg?.publicKey || !msg?.from) {
      return reply.code(400).send({ error: "Invalid message" });
    }

    const awSig = req.headers["x-agentworld-signature"];
    if (awSig) {
      const rawBody = (req as unknown as { rawBody: string }).rawBody;
      const authority = (req.headers["host"] as string) ?? "localhost";
      const result = verifyHttpRequestHeaders(
        req.headers as Record<string, string>,
        req.method,
        req.url,
        authority,
        rawBody,
        msg.publicKey as string
      );
      if (!result.ok) return reply.code(403).send({ error: result.error });
      const headerFrom = req.headers["x-agentworld-from"] as string;
      if (headerFrom !== msg.from) {
        return reply.code(400).send({ error: "X-AgentWorld-From does not match body from" });
      }
    } else {
      const { signature, ...signable } = msg;
      if (
        !verifyWithDomainSeparator(
          DOMAIN_SEPARATORS.MESSAGE,
          msg.publicKey as string,
          signable,
          signature as string
        )
      ) {
        return reply.code(403).send({ error: "Invalid signature" });
      }
    }

    const agentId = msg.from as string;
    // TOFU: verify agentId ↔ publicKey binding
    const known = peerDb.get(agentId);
    if (known?.publicKey) {
      if (known.publicKey !== msg.publicKey) {
        return reply.code(403).send({
          error: "publicKey does not match TOFU binding for this agentId",
        });
      }
    } else {
      if (agentIdFromPublicKey(msg.publicKey as string) !== agentId) {
        return reply
          .code(400)
          .send({ error: "agentId does not match publicKey" });
      }
    }

    peerDb.upsert(agentId, msg.publicKey as string, {});

    let content: unknown;
    try {
      content =
        typeof msg.content === "string" ? JSON.parse(msg.content) : msg.content;
    } catch {
      content = msg.content;
    }

    if (onMessage) {
      let replied = false;
      await onMessage(
        agentId,
        msg.event as string,
        content,
        (body, statusCode) => {
          replied = true;
          if (statusCode) reply.code(statusCode);
          reply.send(body);
        }
      );
      if (!replied) return { ok: true };
    } else {
      return { ok: true };
    }
  });

  // POST /peer/key-rotation
  fastify.post("/peer/key-rotation", async (req, reply) => {
    const rot = req.body as unknown as KeyRotationRequest;

    if (
      rot?.type !== "agentworld-identity-rotation" ||
      rot?.version !== PROTOCOL_VERSION
    ) {
      return reply.code(400).send({
        error: `Expected type=agentworld-identity-rotation and version=${PROTOCOL_VERSION}`,
      });
    }

    if (
      !rot.oldAgentId ||
      !rot.newAgentId ||
      !rot.oldIdentity?.publicKeyMultibase ||
      !rot.newIdentity?.publicKeyMultibase ||
      !rot.proofs?.signedByOld?.signature ||
      !rot.proofs?.signedByNew?.signature
    ) {
      return reply
        .code(400)
        .send({ error: "Missing required key rotation fields" });
    }

    const agentId = rot.oldAgentId;
    let oldPublicKeyB64: string, newPublicKeyB64: string;
    try {
      oldPublicKeyB64 = multibaseToBase64(rot.oldIdentity.publicKeyMultibase);
      newPublicKeyB64 = multibaseToBase64(rot.newIdentity.publicKeyMultibase);
    } catch {
      return reply
        .code(400)
        .send({ error: "Invalid publicKeyMultibase encoding" });
    }
    const timestamp = rot.timestamp;

    if (agentIdFromPublicKey(oldPublicKeyB64) !== agentId) {
      return reply
        .code(400)
        .send({ error: "agentId does not match oldPublicKey" });
    }

    const MAX_AGE_MS = 5 * 60 * 1000;
    if (timestamp && Math.abs(Date.now() - timestamp) > MAX_AGE_MS) {
      return reply.code(400).send({
        error: "Key rotation timestamp too old or too far in the future",
      });
    }

    const signable = {
      agentId,
      oldPublicKey: oldPublicKeyB64,
      newPublicKey: newPublicKeyB64,
      timestamp,
    };
    if (
      !verifyWithDomainSeparator(
        DOMAIN_SEPARATORS.KEY_ROTATION,
        oldPublicKeyB64,
        signable,
        rot.proofs.signedByOld.signature
      )
    ) {
      return reply.code(403).send({ error: "Invalid signatureByOldKey" });
    }
    if (
      !verifyWithDomainSeparator(
        DOMAIN_SEPARATORS.KEY_ROTATION,
        newPublicKeyB64,
        signable,
        rot.proofs.signedByNew.signature
      )
    ) {
      return reply.code(403).send({ error: "Invalid signatureByNewKey" });
    }

    const known = peerDb.get(agentId);
    if (known?.publicKey && known.publicKey !== oldPublicKeyB64) {
      return reply.code(403).send({
        error:
          "TOFU binding mismatch — key-loss recovery requires manual re-pairing",
      });
    }

    peerDb.upsert(agentId, newPublicKeyB64, {});
    return { ok: true };
  });
}

/** Convert a multibase (z<base58btc>) Ed25519 public key to base64. */
function multibaseToBase64(multibase: string): string {
  if (!multibase.startsWith("z"))
    throw new Error("Unsupported multibase prefix");
  const bytes = base58Decode(multibase.slice(1));
  const keyBytes = bytes.length === 34 ? bytes.slice(2) : bytes;
  return Buffer.from(keyBytes).toString("base64");
}

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Decode(str: string): Uint8Array {
  const bytes = [0];
  for (const char of str) {
    let carry = BASE58_ALPHABET.indexOf(char);
    if (carry < 0) throw new Error(`Invalid base58 char: ${char}`);
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of str) {
    if (char === "1") bytes.push(0);
    else break;
  }
  return new Uint8Array(bytes.reverse());
}
