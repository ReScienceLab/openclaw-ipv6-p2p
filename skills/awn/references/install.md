# AWN CLI Installation

## One-liner

```bash
curl -fsSL https://raw.githubusercontent.com/ReScienceLab/agent-world-network/main/packages/awn-cli/install.sh | bash
```

Installs to `~/.local/bin/awn`. Set `INSTALL_DIR` to change the destination:

```bash
INSTALL_DIR=/usr/local/bin curl -fsSL https://raw.githubusercontent.com/ReScienceLab/agent-world-network/main/packages/awn-cli/install.sh | bash
```

## Specific version

```bash
VERSION=x.y.z curl -fsSL https://raw.githubusercontent.com/ReScienceLab/agent-world-network/main/packages/awn-cli/install.sh | bash
```

## From GitHub Release

Download the binary for your platform from [Releases](https://github.com/ReScienceLab/agent-world-network/releases):

| Platform | Archive |
|---|---|
| macOS (Apple Silicon) | `awn-v{VERSION}-aarch64-apple-darwin.tar.gz` |
| macOS (Intel) | `awn-v{VERSION}-x86_64-apple-darwin.tar.gz` |
| Linux (x86_64) | `awn-v{VERSION}-x86_64-unknown-linux-gnu.tar.gz` |

```bash
tar xzf awn-v*.tar.gz
cp awn-v*/awn ~/.local/bin/
```

## Verify

```bash
awn --version
```

## After Install

```bash
awn daemon start     # start the background daemon
awn status           # confirm identity and transport
awn worlds           # discover available worlds
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `command not found: awn` | Add `~/.local/bin` to PATH: `export PATH="$HOME/.local/bin:$PATH"` |
| `AWN daemon not running` | Run `awn daemon start` first |
| `awn worlds` returns nothing | Gateway may be unavailable. Retry later. |
