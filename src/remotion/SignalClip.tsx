import React from "react";
import {
  AbsoluteFill,
  Audio,
  Freeze,
  interpolate,
  OffthreadVideo,
  Series,
  useCurrentFrame,
} from "remotion";
import type { RenderSpec, Word } from "../types";
import { FPS, buildTimeline, deAI } from "../types";

const s = (sec: number) => Math.round(sec * FPS);
const MATT_VOLUME = 0.7; // Matt's VO sits under the source, not over it
const FONT = "'Space Grotesk', system-ui, sans-serif";
const GRADIENT = (bg: string) => `radial-gradient(ellipse at center, #17191c 0%, ${bg} 78%)`;

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
      fontFamily: FONT,
    }}
  >
    <span style={{ color: spec.brand.accent }}>▍</span> {spec.brand.channel_name}
  </div>
);

type Chunk = { start: number; end: number; words: Word[] };

/** Group words into short, stable phrases (~3-4 words) so captions are readable. */
function chunkWords(words: Word[]): Chunk[] {
  const chunks: Chunk[] = [];
  let cur: Word[] = [];
  let curStart = words[0]?.start ?? 0;
  for (const w of words) {
    if (cur.length === 0) curStart = w.start;
    cur.push(w);
    const dur = w.end - curStart;
    const endsSentence = /[.!?]["')\]]?$/.test((w.text || "").trim());
    if (cur.length >= 4 || dur >= 1.7 || endsSentence) {
      chunks.push({ start: curStart, end: w.end, words: cur });
      cur = [];
    }
  }
  if (cur.length) chunks.push({ start: curStart, end: cur[cur.length - 1].end, words: cur });
  return chunks;
}

/** Phrase-chunk captions of the SOURCE, on a dark band for readability. */
const Captions: React.FC<{ words: Word[]; clipStart: number; spec: RenderSpec }> = ({
  words,
  clipStart,
  spec,
}) => {
  const frame = useCurrentFrame();
  const tAbs = clipStart + frame / FPS;
  if (words.length === 0) return null;
  const chunks = chunkWords(words);
  // Current chunk = the one containing tAbs, else the most recent one that has started.
  let chunk = chunks.find((c) => tAbs >= c.start && tAbs < c.end);
  if (!chunk) {
    for (const c of chunks) if (c.start <= tAbs) chunk = c;
  }
  if (!chunk) chunk = chunks[0];
  return (
    <div
      style={{
        position: "absolute",
        bottom: "11%",
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "center",
        padding: "0 56px",
        fontFamily: FONT,
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: "6px 16px",
          maxWidth: "90%",
          padding: "20px 30px",
          borderRadius: 22,
          backgroundColor: "rgba(9, 11, 13, 0.74)",
        }}
      >
        {chunk.words.map((w, i) => {
          const isActive = tAbs >= w.start && tAbs < w.end;
          const text = w.text.replace(/[—–―]/g, "");
          return (
            <span
              key={`${w.start}-${i}`}
              style={{
                fontSize: 62,
                fontWeight: 800,
                lineHeight: 1.12,
                color: isActive ? spec.brand.accent : spec.brand.text,
                WebkitTextStroke: "1px rgba(0,0,0,0.55)",
                textShadow: "0 2px 10px rgba(0,0,0,0.9)",
              }}
            >
              {text}
            </span>
          );
        })}
      </div>
    </div>
  );
};

/** A clean stretch of the source clip (full frame, real audio). */
const SourceSegment: React.FC<{ spec: RenderSpec; startSec: number; endSec: number }> = ({
  spec,
  startSec,
  endSec,
}) => {
  const words = spec.captions.filter(
    (w) => w.end > spec.t_in + startSec && w.start < spec.t_in + endSec
  );
  return (
    <AbsoluteFill style={{ background: GRADIENT(spec.brand.bg) }}>
      <OffthreadVideo
        src={spec.source_url}
        startFrom={s(spec.t_in + startSec)}
        endAt={s(spec.t_in + endSec)}
        style={{ position: "absolute", width: "100%", height: "100%", objectFit: "contain" }}
      />
      <Captions words={words} clipStart={spec.t_in + startSec} spec={spec} />
      <LogoBug spec={spec} />
    </AbsoluteFill>
  );
};

/** The clip PAUSES on a frozen frame while Matt gives his take (source silent). */
const MattInsert: React.FC<{ spec: RenderSpec; freezeSec: number; text: string }> = ({
  spec,
  freezeSec,
  text,
}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 8], [0, 1], { extrapolateRight: "clamp" });
  const clean = deAI(text);
  return (
    <AbsoluteFill style={{ backgroundColor: spec.brand.bg }}>
      {/* Frozen source frame behind Matt */}
      <Freeze frame={s(freezeSec)}>
        <OffthreadVideo
          src={spec.source_url}
          muted
          volume={0}
          style={{ position: "absolute", width: "100%", height: "100%", objectFit: "contain" }}
        />
      </Freeze>
      {/* Dim so it's clear we've cut to commentary */}
      <AbsoluteFill style={{ backgroundColor: "rgba(9,11,13,0.62)" }} />
      <LogoBug spec={spec} />
      <AbsoluteFill
        style={{ justifyContent: "center", alignItems: "center", padding: "0 90px", opacity }}
      >
        <div style={{ textAlign: "center", maxWidth: 940, fontFamily: FONT }}>
          <div
            style={{
              color: spec.brand.accent,
              letterSpacing: 6,
              fontSize: 28,
              fontWeight: 700,
              textTransform: "uppercase",
              marginBottom: 26,
            }}
          >
            ▍ Matt
          </div>
          {clean ? (
            <div
              style={{
                color: spec.brand.text,
                fontSize: 62,
                fontWeight: 800,
                lineHeight: 1.18,
                WebkitTextStroke: "1px rgba(0,0,0,0.45)",
                textShadow: "0 2px 12px rgba(0,0,0,0.8)",
              }}
            >
              {clean}
            </div>
          ) : null}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** Closing take + sign-off card. */
const TakeawayCard: React.FC<{ spec: RenderSpec }> = ({ spec }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill
      style={{
        backgroundColor: spec.brand.bg,
        justifyContent: "center",
        alignItems: "center",
        padding: 110,
        fontFamily: FONT,
      }}
    >
      <div style={{ opacity, textAlign: "center", maxWidth: 900 }}>
        <div
          style={{
            color: spec.brand.accent,
            letterSpacing: 6,
            fontSize: 30,
            fontWeight: 700,
            textTransform: "uppercase",
            marginBottom: 40,
          }}
        >
          The read
        </div>
        <div style={{ color: spec.brand.text, fontSize: 74, lineHeight: 1.15, fontWeight: 700 }}>
          {deAI(spec.title)}
        </div>
        <div style={{ color: spec.brand.accent, fontSize: 44, marginTop: 52, fontWeight: 700 }}>
          {deAI(spec.takeaway_text)}
        </div>
      </div>
      <LogoBug spec={spec} />
    </AbsoluteFill>
  );
};

export const SignalClip: React.FC<{ spec: RenderSpec }> = ({ spec }) => {
  const { items } = buildTimeline(spec);
  return (
    <AbsoluteFill style={{ backgroundColor: spec.brand.bg }}>
      <Series>
        {items.map((it, i) => {
          const frames = Math.max(1, Math.round(it.durSec * FPS));
          if (it.kind === "source") {
            return (
              <Series.Sequence key={i} durationInFrames={frames}>
                <SourceSegment spec={spec} startSec={it.startSec ?? 0} endSec={it.endSec ?? 0} />
              </Series.Sequence>
            );
          }
          if (it.kind === "insert") {
            return (
              <Series.Sequence key={i} durationInFrames={frames}>
                <MattInsert spec={spec} freezeSec={spec.t_in + (it.freezeSec ?? 0)} text={it.text ?? ""} />
                {it.url ? <Audio src={it.url} volume={MATT_VOLUME} /> : null}
              </Series.Sequence>
            );
          }
          return (
            <Series.Sequence key={i} durationInFrames={frames}>
              <TakeawayCard spec={spec} />
              {spec.audio.takeaway_url ? <Audio src={spec.audio.takeaway_url} volume={MATT_VOLUME} /> : null}
            </Series.Sequence>
          );
        })}
      </Series>
    </AbsoluteFill>
  );
};
