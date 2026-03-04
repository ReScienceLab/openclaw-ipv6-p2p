import { interpolate, spring } from "remotion"

export function fadeIn(
  frame: number,
  fps: number,
  delay = 0,
  duration = 0.5
): number {
  const d = delay * fps
  const len = duration * fps
  return interpolate(frame, [d, d + len], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })
}

export function fadeOut(
  frame: number,
  fps: number,
  start: number,
  duration = 0.4
): number {
  const s = start * fps
  const len = duration * fps
  return interpolate(frame, [s, s + len], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })
}

export function springIn(
  frame: number,
  fps: number,
  delay = 0,
  damping = 180
): number {
  return spring({
    frame: frame - delay * fps,
    fps,
    config: { damping },
  })
}

export function clamp(v: number, lo = 0, hi = 1): number {
  return Math.max(lo, Math.min(hi, v))
}

export function progress(
  frame: number,
  startFrame: number,
  endFrame: number
): number {
  return clamp(interpolate(frame, [startFrame, endFrame], [0, 1]))
}
