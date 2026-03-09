import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { parseHostPort, isNativeQuicAvailable, parseStunResponse } from "../dist/transport-quic.js"
import { UDPTransport } from "../dist/transport-quic.js"

describe("parseHostPort", () => {
  it("parses [ipv6]:port format", () => {
    const { host, port } = parseHostPort("[::1]:8098")
    assert.equal(host, "::1")
    assert.equal(port, 8098)
  })

  it("parses [full ipv6]:port format", () => {
    const { host, port } = parseHostPort("[2001:db8::1]:9000")
    assert.equal(host, "2001:db8::1")
    assert.equal(port, 9000)
  })

  it("parses ipv4:port format", () => {
    const { host, port } = parseHostPort("192.168.1.1:8098")
    assert.equal(host, "192.168.1.1")
    assert.equal(port, 8098)
  })

  it("parses hostname:port format", () => {
    const { host, port } = parseHostPort("example.com:443")
    assert.equal(host, "example.com")
    assert.equal(port, 443)
  })

  it("throws on invalid format", () => {
    assert.throws(() => parseHostPort("invalid"), /Invalid address format/)
  })
})

describe("isNativeQuicAvailable", () => {
  it("returns a boolean", () => {
    const result = isNativeQuicAvailable()
    assert.equal(typeof result, "boolean")
  })
})

describe("parseStunResponse", () => {
  it("returns null for too-short buffer", () => {
    const buf = Buffer.alloc(10)
    assert.equal(parseStunResponse(buf), null)
  })

  it("returns null for non-binding-success response", () => {
    const buf = Buffer.alloc(20)
    buf.writeUInt16BE(0x0100, 0) // Not a Binding Success Response
    assert.equal(parseStunResponse(buf), null)
  })

  it("parses MAPPED-ADDRESS attribute", () => {
    // Build a minimal STUN Binding Success Response with MAPPED-ADDRESS
    const buf = Buffer.alloc(32)
    buf.writeUInt16BE(0x0101, 0)  // Binding Success Response
    buf.writeUInt16BE(12, 2)      // Message Length
    // Skip magic cookie + transaction ID (bytes 4-19)
    // MAPPED-ADDRESS attribute at offset 20
    buf.writeUInt16BE(0x0001, 20) // Attribute type: MAPPED-ADDRESS
    buf.writeUInt16BE(8, 22)      // Attribute length
    buf[24] = 0x00                // Padding
    buf[25] = 0x01                // Family: IPv4
    buf.writeUInt16BE(12345, 26)  // Port
    buf[28] = 203                 // IP: 203.0.113.1
    buf[29] = 0
    buf[30] = 113
    buf[31] = 1

    const result = parseStunResponse(buf)
    assert.ok(result)
    assert.equal(result.address, "203.0.113.1")
    assert.equal(result.port, 12345)
  })
})

describe("UDPTransport", () => {
  it("has id 'quic'", () => {
    const qt = new UDPTransport()
    assert.equal(qt.id, "quic")
  })

  it("is not active before start", () => {
    const qt = new UDPTransport()
    assert.equal(qt.isActive(), false)
    assert.equal(qt.address, "")
  })

  it("getEndpoint returns correct structure", () => {
    const qt = new UDPTransport()
    const ep = qt.getEndpoint()
    assert.equal(ep.transport, "quic")
    assert.equal(ep.priority, 0)
  })

  it("can start and stop in test mode", async () => {
    const qt = new UDPTransport()
    const id = { agentId: "test", publicKey: "", privateKey: "", cgaIpv6: "", yggIpv6: "" }
    const ok = await qt.start(id, { testMode: true, quicPort: 0 })
    assert.equal(ok, true)
    assert.equal(qt.isActive(), true)
    assert.ok(qt.address.length > 0)
    await qt.stop()
    assert.equal(qt.isActive(), false)
  })

  it("registers message handlers", () => {
    const qt = new UDPTransport()
    let called = false
    qt.onMessage(() => { called = true })
    // Handler registered but not called since we haven't started
    assert.equal(called, false)
  })
})
