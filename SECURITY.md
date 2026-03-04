# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.2.x   | :white_check_mark: |
| < 0.2   | :x:                |

## Reporting a Vulnerability

**Please do not open a public issue for security vulnerabilities.**

Instead, report vulnerabilities privately:

1. **Email**: Send details to the maintainers via the [ReScienceLab organization](https://github.com/ReScienceLab) contact
2. **GitHub**: Use [private vulnerability reporting](https://github.com/ReScienceLab/DeClaw/security/advisories/new)

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### What to Expect

- Acknowledgment within 48 hours
- Status update within 7 days
- Fix timeline depends on severity (critical: ASAP, high: 7 days, medium: 30 days)

## Security Model

DeClaw uses a 4-layer trust model:

1. **Network layer**: TCP source IP must be Yggdrasil `200::/7` address
2. **Anti-spoofing**: `fromYgg` in message body must match TCP source IP
3. **Application layer**: Ed25519 signature over canonical JSON payload
4. **TOFU**: First-seen public key is pinned; subsequent messages must match

### Sensitive Data

- **Ed25519 private keys** (`~/.openclaw/declaw/identity.json`) — never logged or transmitted
- **Yggdrasil admin socket** (`/var/run/yggdrasil.sock`) — requires appropriate permissions

### Bootstrap Nodes

- Reject non-Yggdrasil source IPs (HTTP 403)
- TOFU key mismatch returns 403 with explicit error
- Yggdrasil config locked with `chattr +i` to prevent key regeneration
