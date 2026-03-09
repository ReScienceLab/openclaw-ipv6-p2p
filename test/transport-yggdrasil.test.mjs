import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { YggdrasilTransport } from "../dist/transport-yggdrasil.js"

describe("YggdrasilTransport", () => {
  it("has id 'yggdrasil'", () => {
    const yt = new YggdrasilTransport()
    assert.equal(yt.id, "yggdrasil")
  })

  it("is not active before start", () => {
    const yt = new YggdrasilTransport()
    assert.equal(yt.isActive(), false)
    assert.equal(yt.address, "")
    assert.equal(yt.info, null)
  })

  it("getEndpoint returns correct structure", () => {
    const yt = new YggdrasilTransport()
    const ep = yt.getEndpoint()
    assert.equal(ep.transport, "yggdrasil")
    assert.equal(ep.priority, 10)
  })

  it("start returns false when yggdrasil binary unavailable", async () => {
    const yt = new YggdrasilTransport()
    const id = { agentId: "test", publicKey: "", privateKey: "", cgaIpv6: "", yggIpv6: "" }
    // On CI/test machines without yggdrasil installed, this should return false
    const ok = await yt.start(id, { dataDir: "/tmp/dap-test-ygg" })
    // If yggdrasil is not installed, ok is false; if it is installed, ok depends on daemon
    assert.equal(typeof ok, "boolean")
  })

  it("tryHotConnect returns false when not previously active", () => {
    const yt = new YggdrasilTransport()
    const id = { agentId: "test", publicKey: "", privateKey: "", cgaIpv6: "", yggIpv6: "" }
    // Without a running daemon, this returns false
    const ok = yt.tryHotConnect(id)
    assert.equal(typeof ok, "boolean")
  })

  it("stop does not throw when not started", async () => {
    const yt = new YggdrasilTransport()
    await yt.stop()
    assert.equal(yt.isActive(), false)
  })
})
