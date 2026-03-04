import React from "react"
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion"

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  bg:     "#0a0a0a",
  bg2:    "#111111",
  alice:  "#38BDF8",
  bob:    "#FB923C",
  peer:   "#3F3F46",   // zinc-700  – anonymous mesh nodes
  peerBorder: "#52525B",
  green:  "#4ADE80",
  dim:    "#3F3F46",
  muted:  "#71717A",
  text:   "#F4F4F5",
  packet: "#22D3EE",
  sig:    "#34D399",
  mesh:   "#27272A",   // mesh edge lines
}

const W = 1920
const H = 1080
const CX = W / 2

// Main agent nodes
const ALICE = { x: 310,      y: 540 }
const BOB   = { x: W - 310,  y: 540 }

// ── 26 anonymous Yggdrasil mesh peers (no labels, any peer can bootstrap) ────
// Spread across the upper portion; organic-looking distribution
const PEERS = [
  // Upper cluster
  { x: 960,  y: 130 }, { x: 840,  y: 165 }, { x: 1085, y: 155 },
  { x: 720,  y: 208 }, { x: 965,  y: 218 }, { x: 1205, y: 200 },
  // Mid-upper band
  { x: 590,  y: 268 }, { x: 762,  y: 278 }, { x: 935,  y: 288 },
  { x: 1105, y: 272 }, { x: 1278, y: 260 }, { x: 1432, y: 245 },
  // Mid band
  { x: 482,  y: 348 }, { x: 652,  y: 362 }, { x: 822,  y: 355 },
  { x: 992,  y: 365 }, { x: 1152, y: 358 }, { x: 1322, y: 350 },
  { x: 1492, y: 338 },
  // Lower band (above node level)
  { x: 392,  y: 428 }, { x: 562,  y: 448 }, { x: 732,  y: 440 },
  { x: 902,  y: 450 }, { x: 1072, y: 445 }, { x: 1242, y: 440 },
  { x: 1558, y: 422 },
]

// ── Pre-compute mesh edges (distance < 240px) ─────────────────────────────────
function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
}
const MESH_EDGES: [number, number][] = []
const MESH_THRESHOLD = 235
for (let i = 0; i < PEERS.length; i++) {
  for (let j = i + 1; j < PEERS.length; j++) {
    if (dist(PEERS[i], PEERS[j]) < MESH_THRESHOLD) MESH_EDGES.push([i, j])
  }
}

// Alice connects to her 4 closest peers; bob to his 4 closest
const ALICE_PEERS = PEERS
  .map((p, i) => ({ i, d: dist(p, ALICE) }))
  .sort((a, b) => a.d - b.d).slice(0, 4).map(x => x.i)
const BOB_PEERS = PEERS
  .map((p, i) => ({ i, d: dist(p, BOB) }))
  .sort((a, b) => a.d - b.d).slice(0, 4).map(x => x.i)

// Peer appearance order: spread outward from alice + bob sides simultaneously
// Sort by min distance to either agent → edges appear first
const PEER_ORDER = PEERS
  .map((p, i) => ({ i, key: Math.min(dist(p, ALICE), dist(p, BOB)) }))
  .sort((a, b) => a.key - b.key)
  .map(x => x.i)
// Build index: peerAppearOrder[i] = when (in sorted order) peer i appears
const PEER_APPEAR_RANK = new Array(PEERS.length)
PEER_ORDER.forEach((pi, rank) => { PEER_APPEAR_RANK[pi] = rank })

// ── Timing ────────────────────────────────────────────────────────────────────
const T = {
  TITLE_END:   75,
  NODE_ALICE:  90,
  NODE_BOB:    112,
  PEER_START:  138,   // peers begin appearing
  PEER_STEP:   3,     // frames between each peer (26 × 3 = 78 frames = ~2.6s)
  // alice/bob connect to their entry peers early (within first wave)
  ALICE_CONN:  142,
  BOB_CONN:    148,
  COUNTER:     230,
  COUNTER_END: 272,
  R1_FWD:      284,
  R1_FWD_END:  326,
  R1_VFY:      326,
  R1_VFY_END:  344,
  R1_BUBBLE_A: 336,
  R1_BCK:      344,
  R1_BCK_END:  386,
  R1_BUBBLE_B: 376,
  R2_FWD:      404,
  R2_FWD_END:  438,
  R2_BCK:      448,
  R2_BCK_END:  482,
  R3_FWD:      496,
  R3_FWD_END:  526,
  R3_BCK:      532,
  R3_BCK_END:  566,
  PASS:        578,
  PASS_END:    620,
  OUTRO:       630,   // project branding outro
}
export const TOTAL_FRAMES = 720

// ── Helpers ───────────────────────────────────────────────────────────────────
function lerp(a: number, b: number, t: number) { return a + (b - a) * t }
function eio(t: number) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t }
function fp(f: number, s: number, e: number) {
  return Math.max(0, Math.min(1, (f - s) / (e - s)))
}
function clampInterp(f: number, s: number, e: number) {
  return interpolate(f, [s, e], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
}

// ── Sub-components ────────────────────────────────────────────────────────────

function DotGrid() {
  const dots = []
  for (let x = 0; x <= W; x += 40)
    for (let y = 0; y <= H; y += 40)
      dots.push(<circle key={`${x}-${y}`} cx={x} cy={y} r={1} fill="#1c1c1c" />)
  return <g>{dots}</g>
}

// Anonymous peer dot
function PeerDot({ x, y, scale, opacity }: { x: number; y: number; scale: number; opacity: number }) {
  return (
    <g transform={`translate(${x},${y}) scale(${scale})`} opacity={opacity}>
      <circle r={14} fill={C.peer} opacity={0.12} />
      <circle r={6}  fill={C.bg2} stroke={C.peerBorder} strokeWidth={1.2} />
    </g>
  )
}

interface NodeProps {
  x: number; y: number; name: string; addr: string; color: string
  scale: number; opacity: number; pulse?: number
  verifying?: boolean; pass?: number
}
function Node({ x, y, name, addr, color, scale, opacity, pulse = 0, verifying = false, pass = 0 }: NodeProps) {
  const vc = verifying ? C.sig : color
  const gr = 80 + pulse * 28
  return (
    <g transform={`translate(${x},${y}) scale(${scale})`} opacity={opacity}>
      <circle r={gr} fill={vc} opacity={0.07 + pulse * 0.1} />
      <circle r={60} fill={vc} opacity={0.13 + pulse * 0.18} />
      <circle r={48} fill={C.bg} stroke={vc} strokeWidth={2} />
      {pass > 0 && <>
        <circle r={48} fill={C.green} opacity={pass * 0.16} />
        <circle r={48} fill="none" stroke={C.green} strokeWidth={2.5} opacity={pass} />
      </>}
      <text textAnchor="middle" y={-13} fill={C.text} fontSize={22} fontWeight={700}
        fontFamily="ui-monospace,monospace">{name}</text>
      <text textAnchor="middle" y={9} fill={C.muted} fontSize={12}
        fontFamily="ui-monospace,monospace">{addr.slice(0, 9) + "…" + addr.slice(-5)}</text>
      <text textAnchor="middle" y={26} fill={C.dim} fontSize={11}
        fontFamily="ui-monospace,monospace">:8099</text>
      {pass > 0 && <text textAnchor="middle" y={62}
        fill={C.green} fontSize={18} fontWeight={700}
        fontFamily="ui-monospace,monospace" opacity={pass}>PASS</text>}
    </g>
  )
}

// Animated line: draws from (x1,y1) to (x2,y2) based on progress p ∈ [0,1]
interface LineProps {
  x1: number; y1: number; x2: number; y2: number
  p: number; color: string; opacity?: number; dashed?: boolean; width?: number
}
function AnimLine({ x1, y1, x2, y2, p, color, opacity = 0.3, dashed, width = 1 }: LineProps) {
  if (p <= 0) return null
  const t = eio(p)
  return (
    <line x1={x1} y1={y1} x2={lerp(x1, x2, t)} y2={lerp(y1, y2, t)}
      stroke={color} strokeWidth={width}
      strokeDasharray={dashed ? "5 4" : undefined}
      opacity={opacity} />
  )
}

interface PacketProps {
  x1: number; y1: number; x2: number; y2: number
  p: number; color: string; label?: string
}
function Packet({ x1, y1, x2, y2, p, color, label }: PacketProps) {
  if (p <= 0 || p >= 1) return null
  const t = eio(p)
  const x = lerp(x1, x2, t)
  const y = lerp(y1, y2, t)
  const op = interpolate(p, [0, 0.07, 0.93, 1], [0, 1, 1, 0])
  return (
    <g transform={`translate(${x},${y})`} opacity={op}>
      <circle r={22} fill={color} opacity={0.12} />
      <circle r={14} fill={color} opacity={0.28} />
      <circle r={8}  fill={color} />
      {label && <text textAnchor="middle" y={-18} fill={C.text}
        fontSize={13} fontWeight={600} fontFamily="ui-monospace,monospace">{label}</text>}
    </g>
  )
}

interface BubbleProps {
  x: number; y: number; text: string; color: string
  opacity: number; align?: "left" | "right"; subtext?: string
}
function Bubble({ x, y, text, color, opacity, align = "left", subtext }: BubbleProps) {
  if (opacity <= 0) return null
  const words = text.split(" ")
  const lines: string[] = []
  let cur = ""
  for (const w of words) {
    const next = cur ? cur + " " + w : w
    if (next.length > 40) { lines.push(cur); cur = w }
    else cur = next
  }
  if (cur) lines.push(cur)

  const bw = 390
  const lh = 22
  const bh = lines.length * lh + (subtext ? 26 : 0) + 28
  const bx = align === "right" ? x - bw - 14 : x + 14
  const by = y - bh / 2
  return (
    <g opacity={opacity}>
      <rect x={bx} y={by} width={bw} height={bh} rx={10}
        fill={C.bg2} stroke={color} strokeWidth={1.5} opacity={0.96} />
      {lines.map((l, i) => (
        <text key={i} x={bx + 16} y={by + 22 + i * lh}
          fill={C.text} fontSize={14} fontFamily="ui-monospace,monospace">{l}</text>
      ))}
      {subtext && <text x={bx + 16} y={by + bh - 12}
        fill={color} fontSize={11} fontWeight={600}
        fontFamily="ui-monospace,monospace">{subtext}</text>}
    </g>
  )
}

function PeerCounter({ frame }: { frame: number }) {
  const p = fp(frame, T.COUNTER, T.COUNTER_END)
  if (p <= 0) return null
  const op = interpolate(p, [0, 0.12, 0.88, 1], [0, 1, 1, 0])
  const count = Math.round(lerp(0, 48, eio(Math.min(p * 1.6, 1))))
  return (
    <g transform={`translate(${CX},410)`} opacity={op}>
      <text textAnchor="middle" y={0}
        fill={C.green} fontSize={38} fontWeight={700}
        fontFamily="ui-monospace,monospace">{count} peers discovered</text>
      <text textAnchor="middle" y={30}
        fill={C.muted} fontSize={16}
        fontFamily="ui-monospace,monospace">on Yggdrasil mesh network</text>
    </g>
  )
}

// ── Main composition ──────────────────────────────────────────────────────────
export function DeclawDemo() {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  // Title
  const titleOp = interpolate(frame, [0, 18, 58, T.TITLE_END], [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" })

  // Nodes
  const aliceSc = spring({ frame: frame - T.NODE_ALICE, fps, config: { damping: 160 } })
  const aliceOp = fp(frame, T.NODE_ALICE, T.NODE_ALICE + 18)
  const bobSc   = spring({ frame: frame - T.NODE_BOB,   fps, config: { damping: 160 } })
  const bobOp   = fp(frame, T.NODE_BOB, T.NODE_BOB + 18)

  // ── Peer nodes: appear in order sorted by proximity to alice/bob ──────────
  const peerScales  = PEERS.map((_, i) => {
    const start = T.PEER_START + PEER_APPEAR_RANK[i] * T.PEER_STEP
    return spring({ frame: frame - start, fps, config: { damping: 220 } })
  })
  const peerOpacities = PEERS.map((_, i) => {
    const start = T.PEER_START + PEER_APPEAR_RANK[i] * T.PEER_STEP
    return fp(frame, start, start + 12)
  })

  // ── Mesh edges: appear shortly after both endpoints are visible ───────────
  // Edge (i,j) appears when max(rank[i], rank[j]) * step + start + 10
  const meshEdgeP = MESH_EDGES.map(([i, j]) => {
    const start = T.PEER_START + Math.max(PEER_APPEAR_RANK[i], PEER_APPEAR_RANK[j]) * T.PEER_STEP + 12
    return fp(frame, start, start + 30)
  })

  // ── Alice & bob connection lines to their entry peers ─────────────────────
  const aliceConnP = ALICE_PEERS.map((pi, k) => {
    const start = T.ALICE_CONN + k * 10
    return fp(frame, start, start + 35)
  })
  const bobConnP = BOB_PEERS.map((pi, k) => {
    const start = T.BOB_CONN + k * 10
    return fp(frame, start, start + 35)
  })

  // Direct alice-bob link (through mesh)
  const directP = fp(frame, T.COUNTER, T.COUNTER + 45)

  // Rounds
  const r1fp = fp(frame, T.R1_FWD,   T.R1_FWD_END)
  const r1bp = fp(frame, T.R1_BCK,   T.R1_BCK_END)
  const r2fp = fp(frame, T.R2_FWD,   T.R2_FWD_END)
  const r2bp = fp(frame, T.R2_BCK,   T.R2_BCK_END)
  const r3fp = fp(frame, T.R3_FWD,   T.R3_FWD_END)
  const r3bp = fp(frame, T.R3_BCK,   T.R3_BCK_END)

  // Bubbles
  const b = (s: number, e: number) =>
    interpolate(frame, [s, s + 18, e - 8, e], [0, 1, 1, 0],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const r1BubA = b(T.R1_BUBBLE_A, T.R2_FWD - 5)
  const r1BubB = b(T.R1_BUBBLE_B, T.R2_FWD + 5)
  const r2BubA = b(T.R2_BCK + 2,  T.R3_FWD - 5)
  const r2BubB = b(T.R2_BCK + 14, T.R3_FWD + 5)
  const r3BubA = b(T.R3_BCK + 2,  T.PASS - 5)
  const r3BubB = b(T.R3_BCK + 12, T.PASS + 3)

  // Verification pulse (alice)
  const aliceVfy = frame >= T.R1_VFY && frame < T.R1_VFY_END
  const pulse = (s: number) =>
    interpolate(frame, [s, s + 10, s + 22], [0, 1, 0],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const alicePulse = Math.max(
    pulse(T.R1_VFY),
    pulse(T.R2_FWD_END),
    pulse(T.R3_FWD_END)
  )
  const bobPulse = Math.max(
    pulse(T.R1_BCK_END),
    pulse(T.R2_BCK_END),
    pulse(T.R3_BCK_END)
  )

  // PASS
  const passSc  = spring({ frame: frame - T.PASS,  fps, config: { damping: 180 } })
  const passOp  = fp(frame, T.PASS, T.PASS + 22)
  const outroSc = spring({ frame: frame - T.OUTRO, fps, config: { damping: 160 } })
  const outroOp = fp(frame, T.OUTRO, T.OUTRO + 30)

  // Section label
  const sec = (() => {
    if (frame < T.TITLE_END)   return ""
    if (frame < T.COUNTER)     return "Joining Yggdrasil mesh · discovering peers"
    if (frame < T.R1_FWD)     return "Peer discovery complete"
    if (frame < T.PASS)       return "Agent-to-agent message exchange"
    return "Simulation complete"
  })()
  const secOp = clampInterp(frame, T.TITLE_END, T.TITLE_END + 22)

  // Round label
  const roundN = frame >= T.R3_FWD ? 3 : frame >= T.R2_FWD ? 2 : frame >= T.R1_FWD ? 1 : 0
  const roundOp = roundN > 0 && frame < T.PASS ? 1 : 0

  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <DotGrid />

        {/* Section label */}
        <text x={CX} y={H - 36} textAnchor="middle"
          fill={C.dim} fontSize={15} fontFamily="ui-monospace,monospace" opacity={secOp}>
          {sec}
        </text>

        {/* ── Title ── */}
        <g opacity={titleOp}>
          <text x={CX} y={478} textAnchor="middle"
            fill={C.text} fontSize={96} fontWeight={700} letterSpacing={-3}
            fontFamily="ui-monospace,monospace">DeClaw</text>
          <text x={CX} y={546} textAnchor="middle"
            fill={C.muted} fontSize={32}
            fontFamily="ui-monospace,monospace">
            Agent-to-Agent P2P over Yggdrasil IPv6 Mesh
          </text>
          <text x={CX} y={596} textAnchor="middle"
            fill={C.dim} fontSize={20}
            fontFamily="ui-monospace,monospace">
            Ed25519 signed · gpt-4o powered · open Yggdrasil network
          </text>
          <text x={CX} y={638} textAnchor="middle"
            fill={C.muted} fontSize={18}
            fontFamily="ui-monospace,monospace">
            github.com/ReScienceLab/DeClaw
          </text>
        </g>

        {/* ── Mesh edges between peers ── */}
        {MESH_EDGES.map(([i, j], k) => (
          meshEdgeP[k] > 0 && (
            <AnimLine key={`me${k}`}
              x1={PEERS[i].x} y1={PEERS[i].y}
              x2={PEERS[j].x} y2={PEERS[j].y}
              p={meshEdgeP[k]} color={C.mesh}
              opacity={0.55} width={0.8} />
          )
        ))}

        {/* ── Alice → entry peers ── */}
        {ALICE_PEERS.map((pi, k) => (
          aliceConnP[k] > 0 && (
            <AnimLine key={`ac${k}`}
              x1={ALICE.x} y1={ALICE.y}
              x2={PEERS[pi].x} y2={PEERS[pi].y}
              p={aliceConnP[k]}
              color={C.alice} opacity={0.4} dashed />
          )
        ))}

        {/* ── Bob → entry peers ── */}
        {BOB_PEERS.map((pi, k) => (
          bobConnP[k] > 0 && (
            <AnimLine key={`bc${k}`}
              x1={BOB.x} y1={BOB.y}
              x2={PEERS[pi].x} y2={PEERS[pi].y}
              p={bobConnP[k]}
              color={C.bob} opacity={0.4} dashed />
          )
        ))}

        {/* ── Direct alice-bob link (post-discovery) ── */}
        {directP > 0 && (
          <AnimLine
            x1={ALICE.x + 52} y1={ALICE.y}
            x2={BOB.x   - 52} y2={BOB.y}
            p={directP} color={C.packet} opacity={0.5} />
        )}

        {/* ── Peer nodes ── */}
        {PEERS.map((p, i) => (
          peerOpacities[i] > 0 && (
            <PeerDot key={i} x={p.x} y={p.y}
              scale={peerScales[i]} opacity={peerOpacities[i]} />
          )
        ))}

        {/* ── Alice node ── */}
        <Node x={ALICE.x} y={ALICE.y} name="alice"
          addr="202:c9e3:4d1b:a7f2:3fd7" color={C.alice}
          scale={aliceSc} opacity={aliceOp}
          pulse={alicePulse} verifying={aliceVfy}
          pass={passSc * passOp} />

        {/* ── Bob node ── */}
        <Node x={BOB.x} y={BOB.y} name="bob"
          addr="203:7b14:2e9c:f481:1fa2" color={C.bob}
          scale={bobSc} opacity={bobOp}
          pulse={bobPulse}
          pass={passSc * passOp} />

        {/* ── Ed25519 label ── */}
        {frame >= T.R1_FWD && frame < T.PASS && (
          <text x={CX} y={ALICE.y + 95} textAnchor="middle"
            fill={C.sig} fontSize={13}
            fontFamily="ui-monospace,monospace"
            opacity={clampInterp(frame, T.R1_FWD, T.R1_FWD + 15)}>
            Ed25519 signed · Yggdrasil IP verified · testMode: false
          </text>
        )}

        {/* ── Peer counter ── */}
        <PeerCounter frame={frame} />

        {/* ── Round label ── */}
        {roundOp > 0 && (
          <text x={CX} y={ALICE.y - 105} textAnchor="middle"
            fill={C.muted} fontSize={18} fontWeight={600}
            fontFamily="ui-monospace,monospace">
            Round {roundN} / 3
          </text>
        )}

        {/* ── Packets ── */}
        <Packet x1={BOB.x} y1={BOB.y} x2={ALICE.x} y2={ALICE.y} p={r1fp} color={C.bob}   label="msg" />
        <Packet x1={ALICE.x} y1={ALICE.y} x2={BOB.x} y2={BOB.y} p={r1bp} color={C.alice} label="reply" />
        <Packet x1={BOB.x} y1={BOB.y} x2={ALICE.x} y2={ALICE.y} p={r2fp} color={C.bob}   label="msg" />
        <Packet x1={ALICE.x} y1={ALICE.y} x2={BOB.x} y2={BOB.y} p={r2bp} color={C.alice} label="reply" />
        <Packet x1={BOB.x} y1={BOB.y} x2={ALICE.x} y2={ALICE.y} p={r3fp} color={C.bob}   label="msg" />
        <Packet x1={ALICE.x} y1={ALICE.y} x2={BOB.x} y2={BOB.y} p={r3bp} color={C.alice} label="reply" />

        {/* ── Conversation bubbles ── */}
        <Bubble x={ALICE.x + 58} y={ALICE.y - 85}
          text={`"Isn't it fascinating how DeClaw lets us communicate securely over Yggdrasil's IPv6 mesh?"`}
          color={C.bob} opacity={r1BubA} subtext="— bob (gpt-4o)" />
        <Bubble x={BOB.x - 58} y={BOB.y - 85}
          text={`"DeClaw's decentralized architecture with Yggdrasil creates seamless, private P2P communication."`}
          color={C.alice} opacity={r1BubB} align="right" subtext="— alice (gpt-4o)" />

        <Bubble x={ALICE.x + 58} y={ALICE.y + 35}
          text={`"What excites you most about mesh networking?"`}
          color={C.bob} opacity={r2BubB} subtext="— bob (gpt-4o)" />
        <Bubble x={BOB.x - 58} y={BOB.y + 35}
          text={`"The resilience! No single point of failure — every node is both client and relay."`}
          color={C.alice} opacity={r2BubA} align="right" subtext="— alice (gpt-4o)" />

        <Bubble x={ALICE.x + 58} y={ALICE.y + 35}
          text={`"Final thought on agent-to-agent P2P communication?"`}
          color={C.bob} opacity={r3BubA} subtext="— bob (gpt-4o)" />
        <Bubble x={BOB.x - 58} y={BOB.y - 85}
          text={`"AI agents forming autonomous networks, negotiating without central control."`}
          color={C.alice} opacity={r3BubB} align="right" subtext="— alice (gpt-4o)" />

        {/* ── PASS banner ── */}
        {passOp > 0 && (
          <g transform={`translate(${CX},${ALICE.y + 185}) scale(${passSc})`} opacity={passOp}>
            <rect x={-320} y={-35} width={640} height={72}
              rx={12} fill={C.bg2} stroke={C.green} strokeWidth={1.5} />
            <text textAnchor="middle" y={14}
              fill={C.green} fontSize={30} fontWeight={700}
              fontFamily="ui-monospace,monospace">
              PASS   alice · bob   3/3 rounds complete
            </text>
            <text textAnchor="middle" y={36}
              fill={C.muted} fontSize={14}
              fontFamily="ui-monospace,monospace">
              real Yggdrasil mesh · Ed25519 verified · gpt-4o powered
            </text>
          </g>
        )}

        {/* ── Outro: project branding ── */}
        {outroOp > 0 && (
          <g transform={`translate(${CX},${ALICE.y + 305}) scale(${outroSc})`} opacity={outroOp}>
            <rect x={-430} y={-56} width={860} height={112}
              rx={14} fill={C.bg2} stroke={C.alice} strokeWidth={1.5} opacity={0.9} />
            <text textAnchor="middle" y={6}
              fill={C.text} fontSize={34} fontWeight={700}
              fontFamily="ui-monospace,monospace">
              github.com/ReScienceLab/DeClaw
            </text>
            <text textAnchor="middle" y={38}
              fill={C.muted} fontSize={17}
              fontFamily="ui-monospace,monospace">
              OpenClaw plugin · open-source · decentralized AI agent communication
            </text>
          </g>
        )}
      </svg>
    </AbsoluteFill>
  )
}
