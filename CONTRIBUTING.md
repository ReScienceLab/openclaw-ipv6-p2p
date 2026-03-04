# Contributing to DeClaw

Thanks for your interest in contributing! DeClaw is an OpenClaw plugin for direct P2P communication between AI agent instances over Yggdrasil IPv6 mesh network.

## Getting Started

### Prerequisites

- Node.js 20+
- npm
- [Yggdrasil](https://yggdrasil-network.github.io/) (for live testing)
- macOS or Linux

### Setup

```bash
git clone https://github.com/ReScienceLab/DeClaw.git
cd DeClaw
npm install
npm run build
node --test test/*.test.mjs
```

Tests import from `dist/` — always build before testing.

### Development

```bash
npm run dev          # watch mode (auto-rebuild on save)
npm run build        # one-time build
node --test test/*.test.mjs   # run all tests
```

## How to Contribute

### Reporting Bugs

- Search [existing issues](https://github.com/ReScienceLab/DeClaw/issues) first
- Use the **Bug Report** issue template
- Include: steps to reproduce, expected vs actual behavior, OS/Node version, Yggdrasil version

### Suggesting Features

- Use the **Feature Request** issue template
- Describe the use case and why it matters for P2P agent communication

### Good First Issues

Look for issues labeled [`good first issue`](https://github.com/ReScienceLab/DeClaw/labels/good%20first%20issue) — these are scoped, well-described tasks ideal for newcomers.

### Submitting Code

1. Fork the repo and create a branch from `develop`:
   ```bash
   git checkout develop
   git checkout -b feature/your-feature
   ```

2. Make your changes, following the conventions below

3. Build and test:
   ```bash
   npm run build
   node --test test/*.test.mjs
   ```

4. Push and create a PR targeting `develop`:
   ```bash
   git push -u origin feature/your-feature
   gh pr create --base develop
   ```

5. Wait for CI (Node 20+22 test matrix) to pass. All PRs are squash-merged.

## Coding Conventions

- **TypeScript**: strict mode, ES2022, no semicolons
- **Tests**: `node:test` + `node:assert/strict` (no external test frameworks)
- **Commit messages**: conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`, `perf:`)
- **No AI watermarks**: do not add AI-generated signatures to commits

### Branch Naming

- `feature/<slug>` — new features
- `fix/<slug>` — bug fixes
- `chore/<slug>` — maintenance

### What We Look For in PRs

- Tests for new functionality
- No regressions (all 44+ existing tests pass)
- Clear commit message explaining *why*, not just *what*
- No secrets, keys, or sensitive data

## Architecture Quick Reference

```
src/index.ts          → Plugin entry point (service, CLI, tools)
src/peer-server.ts    → Inbound HTTP (Fastify): /peer/message, /peer/announce, /peer/ping
src/peer-client.ts    → Outbound signed messages
src/peer-discovery.ts → Bootstrap + gossip discovery loop
src/peer-db.ts        → JSON peer store with TOFU
src/identity.ts       → Ed25519 keypair + CGA address derivation
src/yggdrasil.ts      → Daemon detection/management
src/types.ts          → Shared interfaces
```

Trust model (4-layer): TCP source IP → `fromYgg` anti-spoofing → Ed25519 signature → TOFU key pinning.

## Questions?

Use [GitHub Discussions](https://github.com/ReScienceLab/DeClaw/discussions) for questions, ideas, and general discussion. Issues are for bugs and feature requests.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
