import React from "react";
import {
  AbsoluteFill,
  Audio,
  interpolate,
  OffthreadVideo,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { RenderSpec, Word } from "../types";
import { FPS, computeSegmentSeconds } from "../types";

const s = (sec: number) => Math.round(sec * FPS);

/** Cold-open / takeaway title card with the branded frame + logo bug. */
const Card: React.FC<{
  spec: RenderSpec;
  eyebrow: string;
  text: string;
  signoff?: boolean;
}> = ({ spec, eyebrow, text, signoff }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: "clamp" });
  const { brand } = spec;
  return (
    <AbsoluteFill
      style={{
        backgroundColor: brand.bg,
        justifyContent: "center",
        alignItems: "center",
        padding: 120,
        fontFamily: "'Space Grotesk', system-ui, sans-serif",
      }}
    >
      <div style={{ opacity, textAlign: "center", maxWidth: 860 }}>
        <div
          style={{
            color: brand.accent,
            letterSpacing: 6,
            fontSize: 30,
            fontWeight: 700,
            textTransform: "uppercase",
            marginBottom: 40,
          }}
        >
          {eyebrow}
        </div>
        <div style={{ color: brand.text, fontSize: 76, lineHeight: 1.15, fontWeight: 700 }}>
          {text}
        </div>
        {signoff && (
          <div style={{ color: brand.accent, fontSize: 44, marginTop: 56, fontWeight: 700 }}>
            {spec.takeaway_text}
          </div>
        )}
      </div>
      <LogoBug spec={spec} />
    </AbsoluteFill>
  );
};

const LogoBug: React.FC<{ spec: RenderSpec }> = ({ spec }) => (
  <div
    style={{
      position: "absolute",
      top: 60,
      left: 60,
      color: spec.brand.text,
      opacity: 0.55,
      fontSize: 30,
      fontWeight: 700,
      letterSpacing: 1,
      fontFamily: "'Space Grotesk', system-ui, sans-serif",
    }}
  >
    <span style={{ color: spec.brand.accent }}>▍</span> {spec.brand.channel_name}
  </div>
);

/** Word-by-word caption band: current word in accent, neighbours muted. */
const Captions: React.FC<{ words: Word[]; clipStart: number; spec: RenderSpec }> = ({
  words,
  clipStart,
  spec,
}) => {
  const frame = useCurrentFrame();
  const tAbs = clipStart + frame / FPS; // absolute time in source
  const idx = words.findIndex((w) => tAbs >= w.start && tAbs < w.end);
  if (idx === -1 && words.length === 0) return null;
  const active = idx === -1 ? 0 : idx;
  const window = words.slice(Math.max(0, active - 3), active + 4);
  return (
    <div
      style={{
        position: "absolute",
        bottom: "12%",
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "center",
        padding: "0 56px",
        fontFamily: "'Space Grotesk', system-ui, sans-serif",
      }}
    >
      {/* Dark rounded band keeps captions readable over any background */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: "4px 16px",
          maxWidth: "94%",
          padding: "18px 28px",
          borderRadius: 22,
          backgroundColor: "rgba(9, 11, 13, 0.72)",
        }}
      >
        {window.map((w, i) => {
          const isActive = words.indexOf(w) === active;
          return (
            <span
              key={`${w.start}-${i}`}
              style={{
                fontSize: 58,
                fontWeight: 800,
                lineHeight: 1.1,
                color: isActive ? spec.brand.accent : spec.brand.text,
                opacity: isActive ? 1 : 0.85,
                WebkitTextStroke: "1px rgba(0,0,0,0.55)",
                textShadow: "0 2px 10px rgba(0,0,0,0.9)",
              }}
            >
              {w.text}
            </span>
          );
        })}
      </div>
    </div>
  );
};

export const SignalClip: React.FC<{ spec: RenderSpec }> = ({ spec }) => {
  const { fps } = useVideoConfig();
  const { hookLen, clipLen, takeawayLen } = computeSegmentSeconds(spec);
  const hookFrames = s(hookLen);
  const clipFrames = s(clipLen);
  const takeawayFrames = s(takeawayLen);

  // Words that fall inside the clip window.
  const clipWords = spec.captions.filter((w) => w.end > spec.t_in && w.start < spec.t_out);

  return (
    <AbsoluteFill style={{ backgroundColor: spec.brand.bg }}>
      {/* 1 — COLD OPEN (original) */}
      <Sequence durationInFrames={hookFrames}>
        <Card spec={spec} eyebrow={spec.brand.channel_name} text={spec.hook_text || spec.title} />
        {spec.audio.hook_url ? <Audio src={spec.audio.hook_url} /> : null}
      </Sequence>

      {/* 2 — THE CLIP (evidence) */}
      <Sequence from={hookFrames} durationInFrames={clipFrames}>
        <AbsoluteFill style={{ backgroundColor: spec.brand.bg }}>
          {/* Blurred fill so widescreen sources don't leave empty bars */}
          <OffthreadVideo
            src={spec.source_url}
            startFrom={s(spec.t_in)}
            endAt={s(spec.t_out)}
            muted
            volume={0}
            style={{
              position: "absolute",
              width: "100%",
              height: "100%",
              objectFit: "cover",
              filter: "blur(32px) brightness(0.4)",
              transform: "scale(1.15)",
            }}
          />
          {/* The full source frame, never cropped */}
          <OffthreadVideo
            src={spec.source_url}
            startFrom={s(spec.t_in)}
            endAt={s(spec.t_out)}
            volume={(f) => duckVolume(f, fps, spec)}
            style={{ position: "absolute", width: "100%", height: "100%", objectFit: "contain" }}
          />
          <Captions words={clipWords} clipStart={spec.t_in} spec={spec} />
          <LogoBug spec={spec} />
          {/* Matt interjections over the clip */}
          {spec.audio.interjections.map((it, i) => (
            <Sequence key={i} from={s(it.at)} durationInFrames={s(it.duration_s)}>
              <Audio src={it.url} />
            </Sequence>
          ))}
        </AbsoluteFill>
      </Sequence>

      {/* 3 — TAKEAWAY (original) */}
      <Sequence from={hookFrames + clipFrames} durationInFrames={takeawayFrames}>
        <Card spec={spec} eyebrow="The read" text={spec.title} signoff />
        {spec.audio.takeaway_url ? <Audio src={spec.audio.takeaway_url} /> : null}
      </Sequence>
    </AbsoluteFill>
  );
};

/** Duck the source audio right down while a Matt interjection is playing (full length). */
function duckVolume(frameInClip: number, fps: number, spec: RenderSpec): number {
  const tClip = frameInClip / fps;
  for (const it of spec.audio.interjections) {
    // A small lead-in/out so the duck feels intentional, not abrupt.
    if (tClip >= it.at - 0.15 && tClip < it.at + it.duration_s + 0.15) return 0.08;
  }
  return 1;
}
