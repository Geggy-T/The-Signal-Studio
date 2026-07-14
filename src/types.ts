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
          at: z.number(), // seconds into the CLIP where Matt cuts in
          url: z.string().url(),
          duration_s: z.number().default(3), // worker sets to the real audio length
          text: z.string().optional().default(""), // Matt's words, shown on the frozen frame
        })
      )
      .default([]),
  }),

  // On-screen copy.
  title: z.string().default(""),
  hook_text: z.string().default(""),
  takeaway_text: z.string().default("Noise off."),

  // Brand tokens (defaults = The Signal).
  brand: z
    .object({
      bg: z.string().default("#0f1113"),
      accent: z.string().default("#F5A623"),
      text: z.string().default("#FFFFFF"),
      muted: z.string().default("#8A9099"),
      channel_name: z.string().default("The Signal"),
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
  const windowEnd = abs + 6; // look ahead up to ~6s for a real break
  const endsSentence = (t: string) => /[.!?]["')\]]?$/.test((t || "").trim());
  const clamp = (x: number) => Math.min(C - 0.3, Math.max(0.3, x));

  // 1) Best: cut right after a completed sentence.
  for (let k = i; k < words.length; k++) {
    if (words[k].end > windowEnd) break;
    if (endsSentence(words[k].text)) return clamp(words[k].end - spec.t_in + 0.15);
  }
  // 2) Otherwise the longest pause in the window (a natural clause break).
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
  if (bestIdx !== -1 && bestGap >= 0.22) return clamp(words[bestIdx].end - spec.t_in + 0.12);
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
  const LOOKBACK = 6;
  const TAIL = 0.4; // breath so the speaker's final word fully lands before the takeaway
  const endsSentence = (t: string) => /[.!?]["')\]]?$/.test((t || "").trim());

  // 1) Best: end just after a completed sentence within the lookback window.
  let sentenceEnd = -1;
  for (const w of words) {
    if (w.end > absEnd) break;
    if (w.end >= absEnd - LOOKBACK && endsSentence(w.text)) sentenceEnd = w.end;
  }
  if (sentenceEnd > 0) {
    const rel = Math.min(C, sentenceEnd - spec.t_in + TAIL);
    if (rel > cursor + 1.5) return rel; // keep the final speaker segment a sensible length
  }

  // 2) Otherwise NEVER cut mid-word: end just after the last COMPLETE word at/before
  //    t_out (plus a breath), so the speaker's closing word or two are never clipped.
  let lastWordEnd = -1;
  for (const w of words) {
    if (w.end > absEnd) break;
    lastWordEnd = w.end;
  }
  if (lastWordEnd > 0) {
    const rel = Math.min(C, lastWordEnd - spec.t_in + TAIL);
    if (rel > cursor + 1) return rel;
  }
  return C;
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
    items.push({
      kind: "insert",
      freezeSec: 0,
      durSec: hookDur,
      url: spec.audio.hook_url ?? null,
      text: spec.hook_text || spec.title,
    });
  }

  // 2) REACTIONS — spread evenly across the clip so the speaker gets a real run
  //    before each cut-in, then snapped to a sentence end. Ignore the model's raw
  //    timestamps (they cluster); we place them ourselves.
  type R = { at: number; dur: number; url?: string | null; text: string };
  // Retention: land Matt's FIRST take EARLY (short opening run). Viewers drift
  // during a long uninterrupted opening clip, so the first cut-in comes at ~FIRST_SEG
  // instead of the old even-split (which pushed it ~18s+ in). Later takes still
  // spread across the rest so Matt stays present to the end.
  // IMPORTANT: snapToPause still governs every actual cut, so cuts always land on a
  // natural sentence end or pause and never chop the speaker mid-sentence. We only
  // change where the first cut is AIMED, not how it lands.
  const FIRST_SEG = 8; // aim Matt's first take ~8s into the clip
  const MIN_SEG = 12; // desired minimum speaker run between the later cut-ins
  const HARD_MIN = 7; // never closer than this (still snapped to a clean pause)
  const END_GUARD = 8; // leave a real final speaker stretch before the takeaway
  const raw = spec.audio.interjections;
  const usable = Math.max(0, C - END_GUARD - FIRST_SEG);
  const M = Math.min(raw.length, 1 + Math.floor(usable / MIN_SEG));
  const valid: R[] = [];
  let prev = 0;
  for (let i = 0; i < M; i++) {
    // First take lands early; the rest spread evenly across the remaining clip.
    const target =
      M <= 1 ? FIRST_SEG : FIRST_SEG + (i * (C - END_GUARD - FIRST_SEG)) / (M - 1);
    let at = snapToPause(spec, target);
    at = Math.max(at, prev + HARD_MIN);
    if (at > C - END_GUARD) break; // leave the speaker a real final stretch
    const it = raw[i];
    valid.push({ at, dur: (it.duration_s ?? 3) + INSERT_PAD, url: it.url, text: it.text ?? "" });
    prev = at;
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
    items.push({ kind: "source", startSec: cursor, endSec, durSec: endSec - cursor });
  }
  items.push({ kind: "takeaway", durSec: takeawayLen });

  const totalSec = items.reduce((a, i) => a + i.durSec, 0);
  return { items, totalSec };
}
