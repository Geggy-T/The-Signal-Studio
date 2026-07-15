import React from "react";
import {
  AbsoluteFill,
  Audio,
  Freeze,
  interpolate,
  OffthreadVideo,
  Sequence,
  Series,
  useCurrentFrame,
} from "remotion";
import type { RenderSpec, Word } from "../types";
import { FPS, buildTimeline, deAI, TAKEAWAY_LEAD_SECONDS } from "../types";

const s = (sec: number) => Math.round(sec * FPS);
const MATT_VOLUME = 0.8; // Matt's VO level in the mix (raised ~15% from 0.7)
const FONT = "'Space Grotesk', system-ui, sans-serif";
const GRADIENT = (bg: string) => `radial-gradient(ellipse at center, #17191c 0%, ${bg} 78%)`;

/** The nibs pen-nib mark: sharp point (gets to the point) + concentrated essence. */
const NibMark: React.FC<{ color: string; size?: number }> = ({ color, size = 30 }) => (
  <svg
    width={size * 0.62}
    height={size}
    viewBox="0 0 120 172"
    style={{ display: "inline-block", verticalAlign: "middle", marginRight: 8 }}
  >
    <path d="M16,46 C16,20 30,10 60,10 C90,10 104,20 104,46 L60,172 Z" fill={color} />
    <circle cx="60" cy="66" r="9" fill="#0f1113" />
    <path d="M60,77 L60,150" stroke="#0f1113" strokeWidth="9" strokeLinecap="round" />
  </svg>
);

const LogoBug: React.FC<{ spec: RenderSpec }> = ({ spec }) => (
  <div
    style={{
      position: "absolute",
      top: 60,
      left: 60,
      color: spec.brand.text,
      opacity: 0.6,
      fontSize: 30,
      fontWeight: 700,
      letterSpacing: 1,
      fontFamily: FONT,
      display: "flex",
      alignItems: "center",
    }}
  >
    <NibMark color={spec.brand.text} size={30} />
    {spec.brand.channel_name}
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
        bottom: "20%",
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
                display: "inline-block",
                fontSize: 66,
                fontWeight: 800,
                lineHeight: 1.12,
                color: isActive ? spec.brand.accent : spec.brand.text,
                // Active word "pops" — the karaoke energy viral clip captions use.
                transform: isActive ? "scale(1.16)" : "none",
                WebkitTextStroke: "1.5px rgba(0,0,0,0.6)",
                textShadow: "0 3px 12px rgba(0,0,0,0.95)",
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
    <AbsoluteFill style={{ backgroundColor: spec.brand.bg }}>
      {/* Blurred, darkened copy fills the frame so the 16:9 clip never sits in black
          bars. Rendered into a 1/4-size box then scaled 4x: the gaussian runs on
          ~1/16 the pixels (it is blurred anyway), which is what lets a full 1080p
          render fit in memory instead of OOM-ing. Muted; sharp copy carries audio. */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "25%",
          height: "25%",
          transform: "scale(4)",
          transformOrigin: "top left",
        }}
      >
        <OffthreadVideo
          src={spec.source_url}
          startFrom={s(spec.t_in + startSec)}
          endAt={s(spec.t_in + endSec)}
          muted
          volume={0}
          style={{
            position: "absolute",
            width: "100%",
            height: "100%",
            objectFit: "cover",
            filter: "blur(6px) brightness(0.5)",
          }}
        />
      </div>
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

/** First n words of a string (cleaned). */
function firstWords(sIn: string, n: number): string {
  return deAI(sIn).split(/\s+/).filter(Boolean).slice(0, n).join(" ");
}
/** Everything after the first n words (cleaned). */
function restWords(sIn: string, n: number): string {
  return deAI(sIn).split(/\s+/).filter(Boolean).slice(n).join(" ");
}

/** The clip PAUSES on a frozen frame while Matt gives his take (source silent).
 *  On the OPENING hook, the first few words punch in huge and bold as a
 *  scroll-stopping pattern interrupt in the first ~0.3s. */
const MattInsert: React.FC<{
  spec: RenderSpec;
  freezeSec: number;
  text: string;
  isOpening?: boolean;
}> = ({ spec, freezeSec, text, isOpening }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 8], [0, 1], { extrapolateRight: "clamp" });
  const clean = deAI(text);
  const FLASH_WORDS = 3;
  // Opening flash = the crafted packaging headline if we have one; otherwise fall
  // back to the first few words of the spoken hook. With a real headline the whole
  // hook line still shows below it.
  const headline = deAI(spec.headline || "").trim();
  const flash = isOpening ? headline || firstWords(text, FLASH_WORDS) : "";
  const body = isOpening ? (headline ? clean : restWords(text, FLASH_WORDS)) : clean;
  // Frame-0 hook: the opening headline is FULLY VISIBLE on the literal first frame
  // (no fade) — in the swipe feed that first frame is the de-facto thumbnail, so it
  // must never be blank. A subtle scale punch (0.9->1) adds energy while staying
  // legible from frame 0.
  const flashScale = interpolate(frame, [0, 6], [0.9, 1], { extrapolateRight: "clamp" });
  const flashOpacity = 1;
  // Scale the headline down as it gets longer so a 6-word line still fits.
  const flashFontSize = flash.length <= 14 ? 132 : flash.length <= 26 ? 108 : flash.length <= 40 ? 86 : 70;
  return (
    <AbsoluteFill style={{ backgroundColor: spec.brand.bg }}>
      {/* Blurred fill so the frozen frame never sits in black bars. Rendered at
          1/4 size then scaled 4x so the gaussian is ~16x cheaper (see SourceSegment). */}
      <Freeze frame={s(freezeSec)}>
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "25%",
            height: "25%",
            transform: "scale(4)",
            transformOrigin: "top left",
          }}
        >
          <OffthreadVideo
            src={spec.source_url}
            muted
            volume={0}
            style={{
              position: "absolute",
              width: "100%",
              height: "100%",
              objectFit: "cover",
              filter: "blur(6px) brightness(0.5)",
            }}
          />
        </div>
      </Freeze>
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
      {flash ? (
        <div
          style={{
            position: "absolute",
            top: "13%",
            left: 0,
            right: 0,
            display: "flex",
            justifyContent: "center",
            padding: "0 56px",
            opacity: flashOpacity,
          }}
        >
          <div
            style={{
              transform: `scale(${flashScale})`,
              textAlign: "center",
              color: spec.brand.accent,
              fontFamily: FONT,
              fontSize: flashFontSize,
              fontWeight: 800,
              lineHeight: 1.04,
              letterSpacing: 1,
              textTransform: "uppercase",
              WebkitTextStroke: "2px rgba(0,0,0,0.5)",
              textShadow: "0 4px 20px rgba(0,0,0,0.9)",
            }}
          >
            {flash}
          </div>
        </div>
      ) : null}
      <AbsoluteFill
        style={{ justifyContent: "center", alignItems: "center", padding: "0 90px", opacity }}
      >
        <div
          style={{
            textAlign: "center",
            maxWidth: 940,
            fontFamily: FONT,
            marginTop: isOpening ? 200 : 0,
          }}
        >
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
          {body ? (
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
              {body}
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
          The nib
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
                <MattInsert spec={spec} freezeSec={spec.t_in + (it.freezeSec ?? 0)} text={it.text ?? ""} isOpening={i === 0} />
                {it.url ? <Audio src={it.url} volume={MATT_VOLUME} /> : null}
              </Series.Sequence>
            );
          }
          return (
            <Series.Sequence key={i} durationInFrames={frames}>
              <TakeawayCard spec={spec} />
              {spec.audio.takeaway_url ? (
                <Sequence from={Math.round(TAKEAWAY_LEAD_SECONDS * FPS)}>
                  <Audio src={spec.audio.takeaway_url} volume={MATT_VOLUME} />
                </Sequence>
              ) : null}
            </Series.Sequence>
          );
        })}
      </Series>
    </AbsoluteFill>
  );
};
