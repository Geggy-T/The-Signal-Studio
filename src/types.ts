import { z } from "zod";

/**
 * The render spec the Supabase `render` edge function POSTs to this worker.
 * Times are in SECONDS, relative to the ORIGINAL source video.
 */
export const WordSchema = z.object({
  text: z.string(),
  start: z.number(), // seconds (absolute, in source)
  end: z.number(),
});

export const RenderSpecSchema = z.object({
  clip_candidate_id: z.string(),
  source_url: z.string().url(), // publicly fetchable source video (or Supabase signed URL)
  t_in: z.number(), // clip start in source (s)
  t_out: z.number(), // clip end in source (s)

  // Word-level transcript for the WHOLE source (we slice to the clip window here).
  captions: z.array(WordSchema).default([]),

  // Matt (ElevenLabs) audio, as fetchable URLs.
  audio: z.object({
    hook_url: z.string().url().nullable().optional(),
    takeaway_url: z.string().url().nullable().optional(),
    // Measured by the worker before rendering (seconds). Optional on input.
    hook_duration_s: z.number().nullable().optional(),
    takeaway_duration_s: z.number().nullable().optional(),
    interjections: z
      .array(
        z.object({
          // Legacy hint (seconds into the CLIP). The worker no longer relies on this
          // for placement; kept optional for backward compat with older specs.
          at: z.number().optional().default(0),
          url: z.string().url(),
          duration_s: z.number().default(3), // worker sets to the real audio length
          text: z.string().optional().default(""), // Matt's words, shown on the frozen frame
          // NEW (meaning-anchored placement): a verbatim snippet of the SPEAKER'S line
          // that this reaction immediately follows. The commentary step copies 5-10
          // words straight from the transcript; the worker locates that line and cuts
          // in right after it. This is what makes cut-ins land on natural moments even
          // when punctuation is sparse. Absent on old specs -> worker falls back to the
          // even sentence-end spread.
          after_quote: z.string().optional(),
        })
      )
      .default([]),
  }),

  // On-screen copy.
  title: z.string().default(""),
  // Short packaging HEADLINE (3-6 words) shown huge on the opening frame and baked
  // into the custom thumbnail. Falls back to the first words of the hook if empty.
  headline: z.string().default(""),
  hook_text: z.string().default(""),
  takeaway_text: z.string().default("Noise off."),

  // OPENING (swipe-killer) — v1 A/B test of the first ~1.5s.
  //  Variant A: opening_image_url = a generated cold-open image; the opener shows THIS
  //    full-frame (with push-in) instead of a frozen source frame.
  //  Variant B: peak_frame_sec = the clip's most arresting moment (clip-relative sec);
  //    the opener freezes there instead of at t=0.
  //  hook_words = the punchy 3-6 word ON-SCREEN hook (mute-legible), preferred over the
  //    long headline for the opening flash. opening_variant is telemetry only.
  opening_image_url: z.string().url().nullable().optional(),
  hook_words: z.string().default(""),
  peak_frame_sec: z.number().nullable().optional(),
  opening_variant: z.enum(["generated", "peak", "none"]).nullable().optional(),

  // Brand tokens (defaults = The Signal).
  brand: z
    .object({
      bg: z.string().default("#0f1113"),
      accent: z.string().default("#F5A623"),
      text: z.string().default("#FFFFFF"),
      muted: z.string().default("#8A9099"),
      channel_name: z.string().default("nibs"),
      host_name: z.string().nullable().optional(),
      wordmark: z.string().nullable().optional(),
      font: z.string().nullable().optional(),
      // Per-channel logo (public URL). Rendered top-left every frame. Falls back to
      // the bundled public/logo.png when absent, so nibs keeps its coral "i" mark.
      logo_url: z.string().url().nullable().optional(),
    })
    .default({}),

  // PREFERRED upload path: the Studio's render edge function creates short-lived
  // signed upload URLs (Supabase createSignedUploadUrl) and passes them here.
  // The worker just PUTs the finished files — no Supabase keys needed on the worker.
  upload: z
    .object({
      mp4_put_url: z.string().url(),
      thumb_put_url: z.string().url(),
      mp4_path: z.string(), // storage path to report back, e.g. "renders/clips/<id>.mp4"
      thumb_path: z.string(),
    })
    .nullable()
    .optional(),

  // Optional: after render, auto-upload the MP4 to YouTube (Unlisted by default).
  // If absent or the worker has no YT_* env, the upload is simply skipped.
  publish: z
    .object({
      title: z.string(),
      description: z.string().default(""),
      tags: z.array(z.string()).default([]),
      privacy: z.enum(["private", "unlisted", "public"]).default("unlisted"),
      // Optional scheduled release. ISO-8601/RFC-3339 UTC timestamp. When present
      // the video is uploaded PRIVATE with a YouTube publishAt, so it goes Public
      // by itself at that instant and gets the normal fresh-publish Shorts push
      // (a manual private->public flip does not). Ignored if in the past.
      publish_at: z.string().nullable().optional(),
      // Per-channel YouTube OAuth credentials. When present the worker publishes to
      // THIS channel; when absent it falls back to the worker's YT_* env (nibs).
      credentials: z
        .object({
          client_id: z.string(),
          client_secret: z.string(),
          refresh_token: z.string(),
          category_id: z.string().nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),

  // Optional async callback; if present, worker returns 202 and POSTs result here.
  callback_url: z.string().url().nullable().optional(),
});

export type RenderSpec = z.infer<typeof RenderSpecSchema>;
export type Word = z.infer<typeof WordSchema>;

export const FPS = 30;
export const WIDTH = 1080;
export const HEIGHT = 1920;
// Fallbacks used only when the audio duration couldn't be measured.
export const HOOK_SECONDS = 4;
export const TAKEAWAY_SECONDS = 5;
// Minimum card lengths + a little breathing room after Matt stops speaking.
export const MIN_HOOK_SECONDS = 2.5;
export const MIN_TAKEAWAY_SECONDS = 3;
export const SEGMENT_PAD = 0.6;
// A short breath after the speaker's last word before Matt's closing takeaway VO.
export const TAKEAWAY_LEAD_SECONDS = 0.6;

/**
 * Segment lengths, driven by the MEASURED audio durations so nothing gets cut off.
 * Used by both the composition (SignalClip) and calculateMetadata (Root) so they agree.
 */
export function computeSegmentSeconds(spec: RenderSpec) {
  const hookAudio = spec.audio.hook_duration_s ?? HOOK_SECONDS;
  const takeawayAudio = spec.audio.takeaway_duration_s ?? TAKEAWAY_SECONDS;
  // hookLen = the opening window where Matt's hook VO plays OVER the start of the clip
  // (the clip is on-screen the whole time — no black cold-open card).
  const hookLen = Math.max(MIN_HOOK_SECONDS, hookAudio + SEGMENT_PAD);
  const takeawayLen = Math.max(MIN_TAKEAWAY_SECONDS, takeawayAudio + SEGMENT_PAD + TAKEAWAY_LEAD_SECONDS);
  const clipLen = Math.max(0.5, spec.t_out - spec.t_in);
  // Total = clip (which the hook overlays) + the closing takeaway card.
  return { hookLen, clipLen, takeawayLen, total: clipLen + takeawayLen };
}

/** Strip em/en dashes (a common AI tell) from any on-screen text. */
export function deAI(text: string): string {
  return String(text ?? "")
    .replace(/\s*[—–―]\s*/g, ", ")
    .replace(/\s+,/g, ",")
    .replace(/,\s*,/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export interface TimelineItem {
  kind: "source" | "insert" | "takeaway";
  durSec: number;
  // source segments (clip-relative seconds):
  startSec?: number;
  endSec?: number;
  // Matt inserts (freeze the source at this absolute-in-clip second):
  freezeSec?: number;
  url?: string | null;
  text?: string;
}

/**
 * Reaction timeline: the clip plays, PAUSES on a frozen frame while Matt gives his
 * take (source silent), then resumes. Speaker and Matt never talk at once.
 * Order: [speaker] → [Matt] → [speaker] → [Matt] → … → [takeaway card].
 */
/**
 * Snap a desired clip-relative cut time to the next natural pause in speech,
 * so Matt only cuts in AFTER the speaker finishes their phrase (never mid-sentence).
 */
function snapToPause(spec: RenderSpec, pClip: number): number {
  const C = Math.max(1, spec.t_out - spec.t_in);
  const words = spec.captions;
  if (!words.length) return pClip;
  const abs = spec.t_in + pClip;
  const i = words.findIndex((w) => w.end >= abs);
  if (i === -1) return pClip;
  const endsSentence = (t: string) => /[.!?]["')\]]?$/.test((t || "").trim());
  const clamp = (x: number) => Math.min(C - 0.3, Math.max(0.3, x));

  // 1) Best: the NEXT completed sentence at/after the desired point. Search well
  //    ahead (a sentence can run 10s+), so we snap to a true sentence end rather
  //    than bailing to a mid-sentence pause.
  const sentenceWindow = abs + 16;
  for (let k = i; k < words.length; k++) {
    if (words[k].end > sentenceWindow) break;
    if (endsSentence(words[k].text)) return clamp(words[k].end - spec.t_in + 0.15);
  }
  // 2) Otherwise the longest pause in a wide window, but only if it is a REAL
  //    pause (>= 0.4s). A 0.2s gap is just breathing between words, not a break.
  const windowEnd = abs + 12;
  let bestIdx = -1;
  let bestGap = 0;
  for (let k = i; k < words.length - 1; k++) {
    if (words[k].end > windowEnd) break;
    const gap = words[k + 1].start - words[k].end;
    if (gap > bestGap) {
      bestGap = gap;
      bestIdx = k;
    }
  }
  if (bestIdx !== -1 && bestGap >= 0.4) return clamp(words[bestIdx].end - spec.t_in + 0.12);
  // 3) Fallback: end of the current word (never mid-word).
  return clamp(words[i].end - spec.t_in + 0.08);
}

/**
 * The final cut into the takeaway: end the last speaker segment on a completed
 * sentence near t_out, so Matt's closing take never clips the speaker mid-sentence.
 * Only trims back a few seconds to find a clean break; otherwise ends at t_out.
 */
function snapClipEnd(spec: RenderSpec, cursor: number): number {
  const C = Math.max(1, spec.t_out - spec.t_in);
  const words = spec.captions;
  if (!words.length) return C;
  const absEnd = spec.t_in + C; // = t_out (absolute source seconds)
  // Generous lookback: the clip end often lands deep inside an unfinished sentence,
  // and the last COMPLETED sentence can be 10s+ earlier. The old 6s window missed it,
  // fell through to "last word before t_out", and rolled into the next, half-spoken
  // sentence before the takeaway (the "So GPT…" flash). We would rather end the clip
  // a little early on a clean sentence than roll into an unfinished one.
  const LOOKBACK = 16;
  const MAX_TAIL = 0.3; // small breath after the period
  const endsSentence = (t: string) => /[.!?]["')\]]?$/.test((t || "").trim());

  // Best: the LAST completed sentence end at/before t_out, within the lookback.
  let seIdx = -1;
  for (let k = 0; k < words.length; k++) {
    if (words[k].end > absEnd) break;
    if (words[k].end >= absEnd - LOOKBACK && endsSentence(words[k].text)) seIdx = k;
  }
  if (seIdx >= 0) {
    const se = words[seIdx].end;
    // The tail must NEVER reach the next word — otherwise the following sentence's
    // first word(s) flash on screen before we cut. That is exactly the artifact here.
    const nextStart = words[seIdx + 1]?.start ?? se + MAX_TAIL;
    const tail = Math.min(MAX_TAIL, Math.max(0, nextStart - se - 0.05));
    return Math.min(C, se - spec.t_in + tail);
  }

  // No punctuation in range (rare): end just after the last COMPLETE word (never
  // mid-word), with a minimal breath. Best we can do without sentence boundaries.
  let lastWordEnd = -1;
  for (const w of words) {
    if (w.end > absEnd) break;
    lastWordEnd = w.end;
  }
  if (lastWordEnd > 0) return Math.min(C, lastWordEnd - spec.t_in + 0.2);
  return C;
}

/** Lowercase word tokens, punctuation stripped, for fuzzy transcript matching. */
function normTokens(s: string): string[] {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * MEANING-ANCHORED placement. The commentary step tells us the exact spoken line a
 * reaction follows (after_quote, copied verbatim from the transcript). We find where
 * that line ENDS in the source words and return its clip-relative end time (+breath),
 * so Matt cuts in right after the speaker makes that point. Fuzzy: matches the best
 * in-order run of transcript words against the quote tokens, tolerant of small
 * transcription differences. Returns null if there is no confident match or the
 * point falls outside the usable window.
 */
function resolveQuoteAnchor(spec: RenderSpec, quote: string): number | null {
  const q = normTokens(quote);
  if (q.length < 3) return null;
  const words = spec.captions;
  if (words.length < 3) return null;
  const wTok = words.map((w) => normTokens(w.text)[0] ?? "");

  // Slide a window (quote length + slack) and count in-order matches. Track the index
  // of the transcript word that matched the LAST quote token — that is the cut point.
  let best = { score: 0, endIdx: -1 };
  const span = q.length + 4;
  for (let start = 0; start < words.length; start++) {
    let qi = 0;
    let score = 0;
    let endIdx = -1;
    for (let k = start; k < Math.min(words.length, start + span) && qi < q.length; k++) {
      if (wTok[k] && wTok[k] === q[qi]) {
        score++;
        endIdx = k;
        qi++;
      }
    }
    if (score > best.score) best = { score, endIdx };
  }
  // Require a confident match: >= 60% of the quote tokens in order (min 3).
  const need = Math.max(3, Math.ceil(q.length * 0.6));
  if (best.endIdx < 0 || best.score < need) return null;

  const C = Math.max(1, spec.t_out - spec.t_in);
  const rel = words[best.endIdx].end - spec.t_in + 0.15; // small breath after the line
  if (rel <= 0.6 || rel >= C - 0.4) return null;
  return rel;
}

/**
 * The quote anchor usually sits at a phrase end, but if the speaker barrels straight
 * on with no pause, nudge forward a little to the next sentence end (or real >=0.4s
 * pause) so Matt still cuts in on a clean break — never mid-flow. Small window only,
 * so the cut stays where the meaning is.
 */
function snapForwardToBoundary(spec: RenderSpec, rel: number): number {
  const C = Math.max(1, spec.t_out - spec.t_in);
  const words = spec.captions;
  if (!words.length) return rel;
  const abs = spec.t_in + rel;
  const i = words.findIndex((w) => w.end >= abs - 0.05);
  if (i === -1) return rel;
  const nextStart = words[i + 1]?.start;
  if (nextStart == null || nextStart - words[i].end >= 0.35) return rel; // already clean
  const WINDOW = 3.5;
  const endsSentence = (t: string) => /[.!?]["')\]]?$/.test((t || "").trim());
  for (let k = i; k < words.length; k++) {
    if (words[k].end - abs > WINDOW) break;
    if (endsSentence(words[k].text)) return Math.min(C - 0.4, words[k].end - spec.t_in + 0.15);
  }
  let bestGap = 0;
  let bestIdx = -1;
  for (let k = i; k < words.length - 1; k++) {
    if (words[k].end - abs > WINDOW) break;
    const gap = words[k + 1].start - words[k].end;
    if (gap > bestGap) {
      bestGap = gap;
      bestIdx = k;
    }
  }
  if (bestIdx !== -1 && bestGap >= 0.4) return Math.min(C - 0.4, words[bestIdx].end - spec.t_in + 0.12);
  return rel;
}

export function buildTimeline(spec: RenderSpec): { items: TimelineItem[]; totalSec: number } {
  const C = Math.max(1, spec.t_out - spec.t_in);
  const INSERT_PAD = 0.5;
  const takeawayLen = Math.max(
    MIN_TAKEAWAY_SECONDS,
    (spec.audio.takeaway_duration_s ?? TAKEAWAY_SECONDS) + SEGMENT_PAD + TAKEAWAY_LEAD_SECONDS
  );

  const items: TimelineItem[] = [];

  // 1) OPENING HOOK — Matt lands a killer hook first, over a freeze of the opening
  //    frame (a real video frame, not black), BEFORE the speaker is heard.
  if (spec.audio.hook_url || spec.hook_text) {
    const hookDur = (spec.audio.hook_duration_s ?? HOOK_SECONDS) + INSERT_PAD;
    // Variant B: open on the clip's most arresting frame, not t=0. Clamp into range.
    // (Variant A replaces the frozen frame entirely with the generated image, so the
    // freeze offset is irrelevant there.)
    const peak = spec.peak_frame_sec != null ? Math.max(0, Math.min(C - 0.2, spec.peak_frame_sec)) : 0;
    items.push({
      kind: "insert",
      freezeSec: peak,
      durSec: hookDur,
      url: spec.audio.hook_url ?? null,
      text: spec.hook_text || spec.title,
    });
  }

  // 2) REACTIONS — MEANING-ANCHORED. The commentary step picks the exact spoken line
  //    each take reacts to (after_quote); we cut in right AFTER that line. Count is
  //    ADAPTIVE — we place only as many takes as have a real landing spot — and a hard
  //    minimum gap keeps them from stacking. We NEVER force a fixed number and NEVER
  //    cut mid-sentence. If no quotes resolve (older specs / no match), we fall back to
  //    the even sentence-end spread so we never regress to zero.
  type R = { at: number; dur: number; url?: string | null; text: string };
  const raw = spec.audio.interjections;
  const HARD_MIN = 8; // never two takes closer than this (keeps it natural, unstacked)
  const FIRST_MIN = 4; // earliest a take may land
  const END_GUARD = 10; // real final speaker stretch before the takeaway
  const lastAllowed = Math.max(FIRST_MIN + HARD_MIN, C - END_GUARD);

  // Speaker sentence-end times (clip-relative, + a breath), used by the fallback.
  const endsSentenceTok = (t: string) => /[.!?]["')\]]?$/.test((t || "").trim());
  const sentenceEnds: number[] = [];
  for (const w of spec.captions) {
    if (!endsSentenceTok(w.text)) continue;
    const rel = w.end - spec.t_in + 0.15;
    if (rel > 0.5 && rel < C - 0.4) sentenceEnds.push(rel);
  }
  sentenceEnds.sort((a, b) => a - b);

  const valid: R[] = [];

  // --- PRIMARY: resolve each interjection's after_quote to a real cut time. ---
  const anchored: { at: number; idx: number }[] = [];
  raw.forEach((it, idx) => {
    const quote = it.after_quote;
    if (!quote) return;
    let at = resolveQuoteAnchor(spec, quote);
    if (at == null) return;
    at = snapForwardToBoundary(spec, at);
    if (at < FIRST_MIN || at > lastAllowed) return;
    anchored.push({ at, idx });
  });
  anchored.sort((a, b) => a.at - b.at);

  if (anchored.length) {
    // Enforce spacing: keep a take only if it clears HARD_MIN from the last kept one.
    // idx pairing preserves each reaction's own text + audio (order is meaning, not time).
    let prev = -Infinity;
    for (const c of anchored) {
      if (c.at < prev + HARD_MIN) continue; // too close: drop this collider
      const it = raw[c.idx];
      valid.push({ at: c.at, dur: (it.duration_s ?? 3) + INSERT_PAD, url: it.url, text: it.text ?? "" });
      prev = c.at;
    }
  } else {
    // --- FALLBACK: no quotes matched (old spec). Even spread on real sentence ends. ---
    const FIRST_SEG = 8; // aim the first take ~8s in
    const capacity = Math.max(1, 1 + Math.floor((lastAllowed - FIRST_SEG) / HARD_MIN));
    const M = Math.min(raw.length, capacity);
    let prev = FIRST_SEG - HARD_MIN - 1;
    for (let i = 0; i < M; i++) {
      const frac = M <= 1 ? 0 : i / (M - 1);
      const desired = FIRST_SEG + frac * (lastAllowed - FIRST_SEG);
      let at = -1;
      if (sentenceEnds.length) {
        let bestDist = Infinity;
        for (const s of sentenceEnds) {
          if (s < prev + HARD_MIN) continue; // too close to the previous take
          if (s > lastAllowed) break; // past the final-stretch guard
          const d = Math.abs(s - desired);
          if (d < bestDist) {
            bestDist = d;
            at = s;
          }
        }
        if (at < 0) continue; // no clean sentence end fits here: skip, don't chop
      } else {
        at = snapToPause(spec, desired);
        at = Math.max(at, prev + HARD_MIN);
        at = Math.min(at, lastAllowed);
        if (at <= prev + 0.5) continue;
      }
      const it = raw[i];
      valid.push({ at, dur: (it.duration_s ?? 3) + INSERT_PAD, url: it.url, text: it.text ?? "" });
      prev = at;
    }
  }

  // 3) Interleave clean source segments with the reaction inserts, then the takeaway.
  let cursor = 0;
  for (const r of valid) {
    if (r.at > cursor + 0.05) {
      items.push({ kind: "source", startSec: cursor, endSec: r.at, durSec: r.at - cursor });
    }
    items.push({ kind: "insert", freezeSec: r.at, durSec: r.dur, url: r.url, text: r.text });
    cursor = r.at;
  }
  if (cursor < C - 0.05) {
    const endSec = snapClipEnd(spec, cursor);
    // Only render a trailing speaker run if it is a sensible length ending on a clean
    // sentence. If the clean end lands at/near the last take, cut straight to the
    // takeaway rather than flash a fraction of a rolled/unfinished sentence.
    if (endSec > cursor + 1.0) {
      items.push({ kind: "source", startSec: cursor, endSec, durSec: endSec - cursor });
    }
  }
  items.push({ kind: "takeaway", durSec: takeawayLen });

  const totalSec = items.reduce((a, i) => a + i.durSec, 0);
  return { items, totalSec };
}
