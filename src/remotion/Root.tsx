import React from "react";
import { Composition } from "remotion";
import { SignalClip } from "./SignalClip.js";
import {
  FPS,
  HEIGHT,
  HOOK_SECONDS,
  RenderSpecSchema,
  TAKEAWAY_SECONDS,
  WIDTH,
  type RenderSpec,
} from "../types.js";

// A harmless default so the composition also opens in `remotion studio`.
const defaultSpec: RenderSpec = RenderSpecSchema.parse({
  clip_candidate_id: "preview",
  source_url: "https://storage.googleapis.com/remotion-assets/bigbuckbunny.mp4",
  t_in: 2,
  t_out: 22,
  captions: [],
  audio: { interjections: [] },
  title: "Here's the part that matters.",
  hook_text: "Everyone missed the real signal in this clip.",
  takeaway_text: "Noise off.",
  brand: {},
});

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="SignalClip"
      component={SignalClip as React.FC<Record<string, unknown>>}
      durationInFrames={FPS * (HOOK_SECONDS + 20 + TAKEAWAY_SECONDS)}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
      defaultProps={{ spec: defaultSpec }}
      // Duration is computed from the actual clip length at render time.
      calculateMetadata={({ props }) => {
        const spec = (props as { spec: RenderSpec }).spec;
        const clipLen = Math.max(0.5, spec.t_out - spec.t_in);
        const total = HOOK_SECONDS + clipLen + TAKEAWAY_SECONDS;
        return { durationInFrames: Math.ceil(total * FPS), fps: FPS, width: WIDTH, height: HEIGHT };
      }}
    />
  );
};
