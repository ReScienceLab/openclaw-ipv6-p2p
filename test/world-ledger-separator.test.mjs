import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "fs"
import os from "os"
import path from "path"
import { verifyWithDomainSeparator, DOMAIN_SEPARATORS } from "../packages/agent-world-sdk/dist/crypto.js"
import { loadOrCreateIdentity } from "../packages/agent-world-sdk/dist/identity.js"
import { PROTOCOL_VERSION } from "../packages/agent-world-sdk/dist/version.js"
import { WorldLedger } from "../packages/agent-world-sdk/dist/world-ledger.js"

describe("world ledger separator", () => {
  it("uses the canonical versioned separator constant in the built SDK artifact", () => {
    const worldLedgerPath = new URL("../packages/agent-world-sdk/dist/world-ledger.js", import.meta.url)
    const worldLedgerSource = fs.readFileSync(worldLedgerPath, "utf8")
    const expectedSeparatorDeclaration = `const LEDGER_SEPARATOR = \`AgentWorld-Ledger-\${PROTOCOL_VERSION}\\0\`;`
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-separator-"))
    const identity = loadOrCreateIdentity(dataDir, "separator-test")
    const ledger = new WorldLedger(dataDir, "test-world", identity)
    const [entry] = ledger.getEntries()
    const { worldSig, ...sigPayload } = entry
    const expectedSeparator = `AgentWorld-Ledger-${PROTOCOL_VERSION}\0`

    try {
      assert.ok(
        worldLedgerSource.includes(expectedSeparatorDeclaration),
        `expected ${worldLedgerPath.pathname} to contain ${expectedSeparatorDeclaration}`
      )
      assert.equal(expectedSeparator, `AgentWorld-Ledger-${PROTOCOL_VERSION}\0`)
      assert.equal(
        verifyWithDomainSeparator(expectedSeparator, identity.pubB64, sigPayload, worldSig),
        true
      )
      assert.equal(
        verifyWithDomainSeparator(DOMAIN_SEPARATORS.MESSAGE, identity.pubB64, sigPayload, worldSig),
        false
      )
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
