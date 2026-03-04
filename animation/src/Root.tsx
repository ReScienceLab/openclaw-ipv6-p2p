import React from "react"
import { Composition } from "remotion"
import { DeclawDemo, TOTAL_FRAMES } from "./DeclawDemo"

export const Root: React.FC = () => (
  <Composition
    id="DeclawDemo"
    component={DeclawDemo}
    durationInFrames={TOTAL_FRAMES}
    fps={30}
    width={1920}
    height={1080}
  />
)
