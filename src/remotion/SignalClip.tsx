import React from "react";
import {
  AbsoluteFill,
  Audio,
  Freeze,
  Img,
  interpolate,
  OffthreadVideo,
  Sequence,
  Series,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { loadFont as loadBubbly } from "@remotion/google-fonts/Baloo2";
import { loadFont as loadHeavy } from "@remotion/google-fonts/ArchivoBlack";
import type { RenderSpec, Word } from "../types";
import { FPS, buildTimeline, deAI, TAKEAWAY_LEAD_SECONDS } from "../types";

// Whoosh+click bundled from public/cut.mp3 (staticFile is the render-safe path;
// data URIs are not reliably supported for <Audio> by the renderer).
const CUT_SFX = staticFile("cut.mp3");

const s = (sec: number) => Math.round(sec * FPS);
const MATT_VOLUME = 0.8; // Matt's VO level in the mix (raised ~15% from 0.7)
const SFX_VOLUME = 0.45; // subtle whoosh+click on each cut, under Matt's VO
const FONT = "'Space Grotesk', system-ui, sans-serif";
const { fontFamily: BUBBLY_FONT } = loadBubbly();
// Heavy display face for the big HOOK title / headline only (captions + body stay in
// the clean grotesk). Space Grotesk caps at 700, so a "bold" title rendered there looks
// thin/cheap; Archivo Black is a true 900 that reads premium and punchy.
const { fontFamily: HEAVY_FONT } = loadHeavy();
const fontOf = (spec: RenderSpec): string =>
  spec.brand.font === "bubbly" ? BUBBLY_FONT : FONT;
const GRADIENT = (bg: string) => `radial-gradient(ellipse at center, #17191c 0%, ${bg} 78%)`;

// Channel logo (top-left, every frame), bundled as public/logo.png and loaded via
// staticFile. As of final80 this is the FULL "/nibs." wordmark (1200x400, alpha, coral
// i-dot) rather than the old lone coral "i" — so it is roughly 3:1 rather than 2:1.
//
// HEIGHT: a whole wordmark at the same height as a single letter reads much heavier, so
// the bug is set slightly shorter than the old mark (60 vs 72) to keep the same visual
// weight in the corner. At 60 it occupies ~180px of a 1080px-wide frame.
//
// Bundle per-channel logos here rather than pointing brand.logo_url at the Lovable
// domain: that host returns empty bodies to non-browser clients (the same bot
// protection that broke TikTok domain verification), so Remotion fetches nothing and
// the logo silently disappears.
const LOGO_SRC = staticFile("logo.png");
// Prefer a BUNDLED file over a URL: a bundled logo cannot fail to fetch mid-render.
const logoSrcOf = (spec: RenderSpec): string =>
  spec.brand.logo_file
    ? staticFile(spec.brand.logo_file)
    : spec.brand.logo_url || LOGO_SRC;
const LogoBug: React.FC<{ spec: RenderSpec }> = ({ spec }) => (
  <Img
    src={logoSrcOf(spec)}
    style={{
      position: "absolute",
      top: 52,
      left: 56,
      height: 60,
      width: "auto",
    }}
  />
);

/** Persistent headline kept in the upper third for the WHOLE clip — the SAME large
 *  title as the opening flash (identical size/position/style), just static. Keeps the
 *  story's frame in view the entire time. Font size mirrors the opening flash exactly. */
const headlineFontSize = (h: string) =>
  h.length <= 14 ? 132 : h.length <= 26 ? 108 : h.length <= 40 ? 86 : 70;
const HeadlineBar: React.FC<{ spec: RenderSpec }> = ({ spec }) => {
  const headline = deAI(spec.headline || spec.title || "").trim();
  if (!headline) return null;
  return (
    <div
      style={{
        position: "absolute",
        top: "13%",
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "center",
        padding: "0 56px",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          textAlign: "center",
          color: spec.brand.accent,
          fontFamily: HEAVY_FONT,
          fontSize: headlineFontSize(headline),
          fontWeight: 900,
          lineHeight: 1.02,
          letterSpacing: 0.5,
          textTransform: "uppercase",
          WebkitTextStroke: "3.5px rgba(0,0,0,0.62)",
          textShadow: "0 5px 22px rgba(0,0,0,0.95), 0 2px 4px rgba(0,0,0,0.9)",
        }}
      >
        {headline}
      </div>
    </div>
  );
};

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
        fontFamily: fontOf(spec),
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: "8px 10px",
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
                // Per-word horizontal padding reserves the room the active word's
                // scale transform needs, so the "pop" can never overflow into its
                // neighbours (transforms don't affect flex layout on their own).
                padding: "0 7px",
                fontSize: 66,
                fontWeight: 800,
                lineHeight: 1.12,
                color: isActive ? spec.brand.accent : spec.brand.text,
                // Subtle pop — small enough to stay inside the padding + gap budget.
                transform: isActive ? "scale(1.08)" : "none",
                transformOrigin: "center",
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
  // Slow continuous push-in (~0.6%/s, capped 6%). A talking-head source frame is
  // near-static; this constant drift keeps the frame alive and fights mid-clip
  // scroll-off. Resets each segment, so every cut gives a fresh motion beat.
  const frame = useCurrentFrame();
  // PACING — the body used to be one continuous static shot with a slow drift, which
  // gave a 60s clip about four visual changes. The proven structure wants a visible
  // reframe on a regular beat. We use 5s: retention data has 5-7s changes holding 80%+
  // while 2-4s often drops below 70% — 2-4s suits fast entertainment, not talking heads.
  // We can't honestly jump-cut a single speaker, so we alternate framing (wide <-> tight,
  // slightly repositioned) which reads as a new shot without fabricating a cut.
  const REFRAME_EVERY = 5;
  const tSec = frame / FPS;
  const beat = Math.floor(tSec / REFRAME_EVERY);
  const tight = beat % 2 === 1;
  const withinBeat = tSec % REFRAME_EVERY;
  // Slow drift inside each beat so the frame is never dead still between reframes.
  const drift = Math.min(0.05, withinBeat * 0.005);
  const zoom = (tight ? 1.14 : 1.0) + drift;
  const shiftYpct = tight ? -2.5 : 0;
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
        style={{
          position: "absolute",
          width: "100%",
          height: "100%",
          objectFit: "contain",
          transform: `scale(${zoom}) translateY(${shiftYpct}%)`,
          transformOrigin: "center",
        }}
      />
      <Captions words={words} clipStart={spec.t_in + startSec} spec={spec} />
      <HeadlineBar spec={spec} />
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
  // Opening flash priority (swipe-killer v1): the punchy 3-6 word hook_words if we
  // have them (mute-legible, the star of the scroll-stopper), else the packaging
  // headline, else the first words of the spoken hook.
  const hookWords = deAI(spec.hook_words || "").trim();
  const headline = deAI(spec.headline || "").trim();
  const flash = isOpening ? hookWords || headline || firstWords(text, FLASH_WORDS) : "";
  // With punchy hook_words the opener stays clean — no long body line under the flash.
  const body = isOpening ? (hookWords ? "" : headline ? clean : restWords(text, FLASH_WORDS)) : clean;
  // Variant A: a generated cold-open IMAGE replaces the frozen source frame on the
  // opening beat. Absent -> frozen source frame (Variant B freezes on the peak).
  const openingImg = isOpening ? spec.opening_image_url ?? null : null;
  // Frame-0 hook: the opening headline is FULLY VISIBLE on the literal first frame
  // (no fade) — in the swipe feed that first frame is the de-facto thumbnail, so it
  // must never be blank. A subtle scale punch (0.9->1) adds energy while staying
  // legible from frame 0.
  const flashScale = interpolate(frame, [0, 6], [0.9, 1], { extrapolateRight: "clamp" });
  const flashOpacity = 1;
  // Slow push-in on the frozen frame so Matt's take never plays over a dead-still
  // image (the #1 talking-head retention killer).
  const zoom = 1 + Math.min(0.06, (frame / FPS) * 0.006);
  // Scale the headline down as it gets longer so a 6-word line still fits.
  const flashFontSize = flash.length <= 14 ? 132 : flash.length <= 26 ? 108 : flash.length <= 40 ? 86 : 70;
  return (
    <AbsoluteFill style={{ backgroundColor: spec.brand.bg }}>
      {openingImg ? (
        <>
          {/* Variant A cold-open: the generated image IS the frame that stops the
              thumb. Blurred fill behind so it never sits in black bars, then the
              image full-frame with the same slow push-in. */}
          <Img
            src={openingImg}
            style={{
              position: "absolute",
              width: "100%",
              height: "100%",
              objectFit: "cover",
              filter: "blur(6px) brightness(0.5)",
            }}
          />
          <Img
            src={openingImg}
            style={{
              position: "absolute",
              width: "100%",
              height: "100%",
              objectFit: "cover",
              transform: `scale(${zoom})`,
              transformOrigin: "center",
            }}
          />
          {/* Light dim only — the cold-open image must read bright; text still has
              its own stroke/shadow for legibility. */}
          <AbsoluteFill style={{ backgroundColor: "rgba(9,11,13,0.30)" }} />
        </>
      ) : (
        <>
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
          {/* Frozen source frame. On the OPENING beat we fill the frame (cover) so the
              peak moment is a full-bleed scroll-stopper, not a small letterboxed band in
              black. Mid-clip Matt takes keep "contain" (the established letterbox look). */}
          <Freeze frame={s(freezeSec)}>
            <OffthreadVideo
              src={spec.source_url}
              muted
              volume={0}
              style={{
                position: "absolute",
                width: "100%",
                height: "100%",
                objectFit: isOpening ? "cover" : "contain",
                transform: `scale(${zoom})`,
                transformOrigin: "center",
              }}
            />
          </Freeze>
          {/* Dim: lighter on the opening (full-bleed frame must read bright) than on
              mid-clip takes (where we want it clearly "cut to commentary"). */}
          <AbsoluteFill
            style={{ backgroundColor: isOpening ? "rgba(9,11,13,0.42)" : "rgba(9,11,13,0.62)" }}
          />
        </>
      )}
      {/* Keep the pinned headline up top on Matt's takes too (but not the opening,
          which shows the big animated flash instead). */}
      {isOpening ? null : <HeadlineBar spec={spec} />}
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
              fontFamily: HEAVY_FONT,
              fontSize: flashFontSize,
              fontWeight: 900,
              lineHeight: 1.02,
              letterSpacing: 0.5,
              textTransform: "uppercase",
              WebkitTextStroke: "3.5px rgba(0,0,0,0.62)",
              textShadow: "0 5px 22px rgba(0,0,0,0.95), 0 2px 4px rgba(0,0,0,0.9)",
            }}
          >
            {flash}
          </div>
        </div>
      ) : null}
      {/* Clean cold-open: with punchy hook_words the opener shows ONLY the big flash,
          no name label / body line. Otherwise keep the "cut to Matt" treatment. */}
      {isOpening && hookWords ? null : (
        <AbsoluteFill
          style={{ justifyContent: "center", alignItems: "center", padding: "0 90px", opacity }}
        >
          <div
            style={{
              textAlign: "center",
              maxWidth: 940,
              fontFamily: fontOf(spec),
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
              ▍ {spec.brand.host_name || "Matt"}
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
      )}
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
        fontFamily: fontOf(spec),
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
          {(spec.brand.wordmark || spec.brand.channel_name || "").toString()}
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
                {/* The loop frame renders identically to the opening frame (isOpening),
                    so the last frame of the video matches the first and the auto-replay
                    is a match cut rather than a jarring reset. */}
                <MattInsert spec={spec} freezeSec={spec.t_in + (it.freezeSec ?? 0)} text={it.text ?? ""} isOpening={i === 0 || !!it.loop} />
                {/* Whoosh+click on EVERY Matt card — the "something happened" jolt.
                    Skipped on the subliminal brand flash, which isn't Matt speaking
                    (otherwise it double-whooshes 0.13s before his opening line). */}
                {it.flash ? null : <Audio src={CUT_SFX} volume={SFX_VOLUME} />}
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
