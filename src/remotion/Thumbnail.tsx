import React from "react";
import { AbsoluteFill, Freeze, OffthreadVideo } from "remotion";
import type { RenderSpec } from "../types";
import { FPS, deAI } from "../types";

import { loadFont as loadBubbly } from "@remotion/google-fonts/Baloo2";
const FONT = "'Space Grotesk', system-ui, sans-serif";
const { fontFamily: BUBBLY_FONT } = loadBubbly();
const fontOf = (spec: RenderSpec): string =>
  spec.brand.font === "bubbly" ? BUBBLY_FONT : FONT;

/**
 * Custom thumbnail for the channel grid + YouTube search/suggested: a bright, full
 * source frame with the packaging HEADLINE baked in big and bold. Rendered as a
 * single still (see the "Thumbnail" composition in Root). `thumbSec` is ABSOLUTE
 * source seconds (t_in already added), so it works whether the source was pre-cut
 * (t_in rebased to 0) or a remote file.
 */
export const ThumbnailStill: React.FC<{ spec: RenderSpec; thumbSec: number }> = ({
  spec,
  thumbSec,
}) => {
  const headline = (deAI(spec.headline || "").trim() || deAI(spec.title || "").trim()).toUpperCase();
  const size =
    headline.length <= 16 ? 148 : headline.length <= 30 ? 118 : headline.length <= 46 ? 96 : 78;
  return (
    <AbsoluteFill style={{ backgroundColor: spec.brand.bg }}>
      <Freeze frame={Math.max(0, Math.round(thumbSec * FPS))}>
        <OffthreadVideo
          src={spec.source_url}
          muted
          volume={0}
          style={{ position: "absolute", width: "100%", height: "100%", objectFit: "cover" }}
        />
      </Freeze>
      {/* Darken toward the bottom so the headline stays legible over any frame. */}
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(to bottom, rgba(9,11,13,0.20) 0%, rgba(9,11,13,0.05) 42%, rgba(9,11,13,0.88) 100%)",
        }}
      />
      {/* Channel bug, top-left. */}
      <div
        style={{
          position: "absolute",
          top: 56,
          left: 60,
          color: spec.brand.text,
          opacity: 0.92,
          fontSize: 36,
          fontWeight: 800,
          letterSpacing: 1,
          fontFamily: fontOf(spec),
          textShadow: "0 2px 12px rgba(0,0,0,0.9)",
        }}
      >
        <span style={{ color: spec.brand.accent }}>▍</span> {spec.brand.channel_name}
      </div>
      {/* Headline, bottom. */}
      <AbsoluteFill
        style={{ justifyContent: "flex-end", alignItems: "center", padding: "0 64px 150px" }}
      >
        <div
          style={{
            textAlign: "center",
            color: spec.brand.text,
            fontFamily: fontOf(spec),
            fontSize: size,
            fontWeight: 800,
            lineHeight: 1.05,
            letterSpacing: 0.5,
            textTransform: "uppercase",
            WebkitTextStroke: "2px rgba(0,0,0,0.5)",
            textShadow: "0 6px 28px rgba(0,0,0,0.96)",
          }}
        >
          {headline}
        </div>
        <div
          style={{
            marginTop: 30,
            width: 130,
            height: 9,
            borderRadius: 5,
            backgroundColor: spec.brand.accent,
          }}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
