import fs from "fs"
import path from "path"
import nacl from "tweetnacl"
import { agentIdFromPublicKey } from "./crypto.js"
import type { Identity } from "./types.js"

/**
 * Load an existing Ed25519 identity from dataDir or create a new one.
 * @param dataDir  Directory where identity file is stored
 * @param name     Identity file name (without .json), e.g. "world-identity" or "gateway-identity"
 */
export function loadOrCreateIdentity(dataDir: string, name = "identity"): Identity {
  fs.mkdirSync(dataDir, { recursive: true })
  const idFile = path.join(dataDir, `${name}.json`)

  let keypair: nacl.SignKeyPair
  if (fs.existsSync(idFile)) {
    const saved = JSON.parse(fs.readFileSync(idFile, "utf8")) as { seed: string }
    keypair = nacl.sign.keyPair.fromSeed(Buffer.from(saved.seed, "base64"))
  } else {
    const seed = nacl.randomBytes(32)
    keypair = nacl.sign.keyPair.fromSeed(seed)
    fs.writeFileSync(idFile, JSON.stringify({
      seed: Buffer.from(seed).toString("base64"),
      publicKey: Buffer.from(keypair.publicKey).toString("base64"),
    }, null, 2))
  }

  const pubB64 = Buffer.from(keypair.publicKey).toString("base64")
  return {
    agentId: agentIdFromPublicKey(pubB64),
    pubB64,
    secretKey: keypair.secretKey,
    keypair,
  }
}
