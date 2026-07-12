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
import { FPS, HOOK_SECONDS, TAKEAWAY_SECONDS } from "../types";

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
        bottom: 300,
        left: 0,
        right: 0,
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "center",
        gap: "0 16px",
        padding: "0 80px",
        fontFamily: "'Space Grotesk', system-ui, sans-serif",
      }}
    >
      {window.map((w, i) => {
        const isActive = words.indexOf(w) === active;
        return (
          <span
            key={`${w.start}-${i}`}
            style={{
              fontSize: 62,
              fontWeight: 800,
              color: isActive ? spec.brand.accent : spec.brand.text,
              opacity: isActive ? 1 : 0.7,
              textShadow: "0 4px 24px rgba(0,0,0,0.85)",
            }}
          >
            {w.text}
          </span>
        );
      })}
    </div>
  );
};

export const SignalClip: React.FC<{ spec: RenderSpec }> = ({ spec }) => {
  const { fps } = useVideoConfig();
  const clipLen = Math.max(0.5, spec.t_out - spec.t_in);
  const hookFrames = s(HOOK_SECONDS);
  const clipFrames = s(clipLen);
  const takeawayFrames = s(TAKEAWAY_SECONDS);

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
        <AbsoluteFill>
          {/* source, cover-cropped to vertical */}
          <OffthreadVideo
            src={spec.source_url}
            startFrom={s(spec.t_in)}
            endAt={s(spec.t_out)}
            volume={(f) => duckVolume(f, fps, spec)}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
          <Captions words={clipWords} clipStart={spec.t_in} spec={spec} />
          <LogoBug spec={spec} />
          {/* Josh interjections over the clip */}
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

/** Duck the source audio to ~15% while a Josh interjection is playing. */
function duckVolume(frameInClip: number, fps: number, spec: RenderSpec): number {
  const tClip = frameInClip / fps;
  for (const it of spec.audio.interjections) {
    if (tClip >= it.at && tClip < it.at + it.duration_s) return 0.15;
  }
  return 1;
}
