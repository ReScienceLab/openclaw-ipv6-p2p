# DeClaw demo — agent-to-agent P2P over Yggdrasil IPv6
# Generates: assets/demo.gif
# Usage: vhs docker/demo.tape

# ── Output ───────────────────────────────────────────────────────────────────
Output assets/demo.gif

# ── Dependencies ─────────────────────────────────────────────────────────────
Require bash

# ── Terminal settings (Width/Height in pixels) ────────────────────────────────
Set Shell         "bash"
Set FontSize      13
Set Width         1100
Set Height        800
Set Theme         "Dracula"
Set WindowBar     Colorful
Set WindowBarSize 28
Set Padding       16
Set TypingSpeed   45ms
Set PlaybackSpeed 1.5
Set LoopOffset    50%

# ── cd to project root (hidden) ───────────────────────────────────────────────
Hide
Type "cd /Users/yilin/Developer/GitPlayground/openclaw-ipv6-p2p"
Enter
Sleep 300ms
Show

# ── Show docker/ project layout ───────────────────────────────────────────────
Type "ls docker/"
Enter
Sleep 2s

# ── Run the curated demo replay ───────────────────────────────────────────────
Type "bash docker/demo-replay.sh"
Enter
Sleep 22s
