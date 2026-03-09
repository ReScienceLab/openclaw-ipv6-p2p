---
"@resciencelab/declaw": minor
---

BREAKING CHANGE: Peer identity migrated from Yggdrasil IPv6 address (`yggAddr`) to `agentId` (`sha256(publicKey)[:32]`). All v1 protocol compatibility removed — existing peer databases will not migrate.

- Transport abstraction layer with TransportManager for automatic selection
- YggdrasilTransport wrapper and UDPTransport (plain UDP with STUN NAT traversal)
- Multi-transport endpoint support in peer discovery and messaging
- `agentId` as primary peer identity with `did:key` derivation for W3C compatibility
- Application-layer Ed25519 signatures + TOFU binding as transport-agnostic trust anchor
