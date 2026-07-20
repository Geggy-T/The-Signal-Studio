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
  // 3-BEAT COLD OPEN (final69). When these are set, the opener becomes:
  //  Beat 1 (~1.2s) brand frame + hook_words, no VO ->
  //  Beat 2 the hand-picked DRAMATIC line playing LIVE from [teaser_start_sec, teaser_end_sec]
  //         (real audio) -> Beat 3 Matt freezes it and lands his short hook.
  // Clip-relative seconds. Absent -> legacy single-beat opener (frame + VO together).
  teaser_start_sec: z.number().nullable().optional(),
  teaser_end_sec: z.number().nullable().optional(),

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
      // Per-channel logo, top-left every frame. Resolution order in SignalClip:
      //   1) logo_file — a file BUNDLED in the worker's public/ dir, e.g.
      //      "datingis-logo.png". PREFERRED: no network fetch during render, so it
      //      cannot silently vanish.
      //   2) logo_url  — an absolute URL. Use only for a host we control. NOT the
      //      Lovable domain: it returns empty bodies to non-browser clients (the same
      //      bot protection that broke TikTok domain verification), so Remotion fetches
      //      nothing and the logo disappears with no error.
      //   3) the bundled public/logo.png default (the nibs "/nibs." wordmark).
      logo_file: z.string().nullable().optional(),
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
// TIGHT CUTS. These pads are added AFTER the measured audio length, so they only exist
// to stop the tail being clipped — anything beyond that is dead air, and dead air is
// what makes an edit feel slow. Kept deliberately small.
export const SEGMENT_PAD = 0.35;
// A short breath after the speaker's last word before Matt's closing takeaway VO.
export const TAKEAWAY_LEAD_SECONDS = 0.35;

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
  // True only for the subliminal opening brand flash. It is technically an "insert" but
  // it is NOT Matt speaking, so it must not fire the whoosh (otherwise you get two
  // whooshes 0.13s apart). The whoosh belongs to Matt's cards.
  flash?: boolean;
  // The LOOP frame: the final beat, rendered identically to the opening frame so the
  // last frame matches the first. Shorts replay automatically, and ending on a static
  // card makes the loop land as a hard mismatch; matching frames make it seamless.
  loop?: boolean;
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

/**
 * The cold-open teaser MUST end on a complete thought. Two things used to break that:
 * the Studio resolves the span from the matched quote words (the quote is only 4-8 words
 * while the spoken line usually runs longer, so it stopped mid-sentence), and a hard cap
 * chopped anything longer outright. Both produce a harsh cut into the next beat.
 * So: extend forward to the next sentence end, else a real pause, never mid-word, never
 * past the allowance, and never let the tail run into the following word.
 */
function snapTeaserEnd(spec: RenderSpec, startSec: number, endSec: number, maxSec: number): number {
  const C = Math.max(1, spec.t_out - spec.t_in);
  const words = spec.captions;
  const hardMax = Math.min(C - 0.1, startSec + maxSec);
  if (!words.length) return Math.min(Math.max(endSec, startSec + 0.6), hardMax);

  const endsSentence = (t: string) => /[.!?]["')\]]?$/.test((t || "").trim());
  const absEnd = spec.t_in + endSec;
  const TAIL = 0.18;
  // Tail must never reach the next word, or its first syllable flashes before the cut.
  const tailFor = (idx: number, wordEnd: number): number => {
    const nextStart = words[idx + 1]?.start;
    if (nextStart == null) return TAIL;
    return Math.min(TAIL, Math.max(0, nextStart - wordEnd - 0.04));
  };

  // 1) Best: the next completed sentence at/after the quote end, within the allowance.
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.end < absEnd - 0.05) continue;
    const rel = w.end - spec.t_in;
    if (rel > hardMax) break;
    if (endsSentence(w.text)) return Math.min(hardMax, rel + tailFor(i, w.end));
  }

  // 2) Otherwise the largest REAL pause (>=0.35s) in the allowance — a natural breath.
  let bestIdx = -1;
  let bestGap = 0;
  for (let i = 0; i < words.length - 1; i++) {
    const w = words[i];
    if (w.end < absEnd - 0.05) continue;
    const rel = w.end - spec.t_in;
    if (rel > hardMax) break;
    const gap = words[i + 1].start - w.end;
    if (gap > bestGap) {
      bestGap = gap;
      bestIdx = i;
    }
  }
  if (bestIdx !== -1 && bestGap >= 0.35) {
    const w = words[bestIdx];
    return Math.min(hardMax, w.end - spec.t_in + tailFor(bestIdx, w.end));
  }

  // 3) Fallback: end of the word we are currently inside — never mid-word.
  let lastIdx = -1;
  for (let i = 0; i < words.length; i++) {
    const rel = words[i].end - spec.t_in;
    if (rel > hardMax) break;
    if (words[i].end >= absEnd - 0.05) {
      lastIdx = i;
      break;
    }
  }
  if (lastIdx >= 0) {
    const w = words[lastIdx];
    return Math.min(hardMax, w.end - spec.t_in + tailFor(lastIdx, w.end));
  }
  return Math.min(Math.max(endSec, startSec + 0.6), hardMax);
}

/**
 * The body must not START mid-sentence. We fixed the teaser's END landing mid-word;
 * this is the mirror problem at the hand-over. When the cold open finishes (or when we
 * flash-forward back to the top of the clip), dropping in halfway through a spoken
 * sentence reads as a bad edit — the selection can only bias where t_in lands, it
 * can't guarantee a sentence boundary. So: snap forward to the first word that BEGINS
 * a sentence, within a short window. Losing a fragment of a half-heard sentence is
 * always better than entering on one.
 */
function snapBodyStart(spec: RenderSpec, startSec: number): number {
  const C = Math.max(1, spec.t_out - spec.t_in);
  const words = spec.captions;
  if (!words.length) return startSec;
  const endsSentence = (t: string) => /[.!?]["')\]]?$/.test((t || "").trim());
  const abs = spec.t_in + startSec;
  const WINDOW = 3.5; // never skip more than this hunting for a clean entry
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.start < abs - 0.05) continue;
    const rel = w.start - spec.t_in;
    if (rel - startSec > WINDOW) break;
    const prev = words[i - 1];
    // A word begins a sentence if it is the first word, or the previous word ended one.
    if (!prev || endsSentence(prev.text)) {
      // Small lead-in so we don't clip the attack of the first syllable.
      return Math.max(0, Math.min(C - 0.5, rel - 0.08));
    }
  }
  return startSec;
}

export function buildTimeline(spec: RenderSpec): { items: TimelineItem[]; totalSec: number } {
  const C = Math.max(1, spec.t_out - spec.t_in);
  // TIGHT CUTS: added on top of Matt's MEASURED audio length, so this is purely the tail
  // guard against clipping his last word. Anything more is dead air on every single
  // interjection — the fastest way to make an edit feel sluggish.
  const INSERT_PAD = 0.2;
  const takeawayLen = Math.max(
    MIN_TAKEAWAY_SECONDS,
    (spec.audio.takeaway_duration_s ?? TAKEAWAY_SECONDS) + SEGMENT_PAD + TAKEAWAY_LEAD_SECONDS
  );

  const items: TimelineItem[] = [];

  // 1) OPENING HOOK — Matt lands a killer hook first, over a freeze of the opening
  //    frame (a real video frame, not black), BEFORE the speaker is heard.
  // Variant B: open on the clip's most arresting frame, not t=0. Clamp into range.
  // (Variant A replaces the frozen frame entirely with the generated image, so the
  // freeze offset is irrelevant there.)
  const peak = spec.peak_frame_sec != null ? Math.max(0, Math.min(C - 0.2, spec.peak_frame_sec)) : 0;
  const hasHook = Boolean(spec.audio.hook_url || spec.hook_text);
  const tStart = spec.teaser_start_sec;
  const tEnd = spec.teaser_end_sec;
  const hasTeaser = tStart != null && tEnd != null && tEnd > tStart;
  // Where the main body starts after the cold open. Normally 0 (play the clip from the
  // top), but the v2 cold open can roll straight on from the end of the teaser instead.
  let bodyStart = 0;
  // Span of source already spent in the cold-open teaser. When the body rewinds to the
  // top, this span is skipped on the way through so the money line is never heard twice.
  let skipFrom: number | null = null;
  let skipTo: number | null = null;

  if (hasTeaser) {
    // COLD OPEN v2 — instant validation. Every Short worth copying goes STRAIGHT into
    // content, so:
    //   Beat 1 (~0.13s) a subliminal brand flash — present in the file (and so usable as
    //          the auto thumbnail) but far too short to register as a hold.
    //   Beat 2  Matt's punchy claim, over a FROZEN frame of the money line's FIRST frame.
    //   Beat 3  that freeze RELEASES into the money line playing live — the receipt for
    //          Matt's claim, arriving within ~2s. Curiosity opened, then instantly paid.
    const FRAME_FLASH = 4 / FPS; // 4 frames
    items.push({ kind: "insert", freezeSec: peak, durSec: FRAME_FLASH, url: null, text: "", flash: true });

    const ts = Math.max(0, Math.min(C - 0.3, tStart));
    // Let the line FINISH. The old hard 3.2s truncation cut lines mid-sentence, which is
    // what made the cut into the next beat feel harsh. We now allow up to 5s and snap to
    // the nearest sentence end / real pause inside that.
    const MAX_TEASER = 5.0;
    let te = Math.max(ts + 0.6, Math.min(C - 0.1, tEnd));
    te = snapTeaserEnd(spec, ts, te, MAX_TEASER);

    // Beat 2: freeze on ts (not te) so the cut to live footage is a seamless UNFREEZE of
    // the very frame Matt was talking over, rather than a jump to somewhere else.
    if (hasHook) {
      // Tight tail (not the usual INSERT_PAD): we want the freeze to release on Matt's
      // LAST WORD, so the proof lands the instant he stops. Half a second of dead air
      // here is the difference between "instant validation" and a beat of nothing.
      const HOOK_TAIL = 0.15;
      const hookDur = (spec.audio.hook_duration_s ?? HOOK_SECONDS) + HOOK_TAIL;
      items.push({
        kind: "insert",
        freezeSec: ts,
        durSec: hookDur,
        url: spec.audio.hook_url ?? null,
        text: spec.hook_text || spec.title,
      });
    }

    // Beat 3: the money line, LIVE.
    items.push({ kind: "source", startSec: ts, endSec: te, durSec: te - ts });

    // Beat 4: if the money line sits at the clip's opening (the selection step aims for
    // this), just keep ROLLING FORWARD from where the teaser ended — no rewind, no repeat,
    // no momentum dip. If the line is buried deep in the clip, fall back to the
    // flash-forward: replay from the top so the viewer still gets the build-up.
    const CONTINUOUS_MAX = 3;
    if (ts <= CONTINUOUS_MAX) {
      bodyStart = te;
    } else {
      // The money line is buried deep, so we DO rewind to give the viewer the build-up.
      // But the teaser span itself must never play twice: hearing the speaker say the
      // exact same sentence again a few seconds later reads as a stutter in the edit and
      // is the single most obvious "this was machine-cut" tell. Play 0 -> ts, then jump
      // the span we already used and resume at te.
      bodyStart = 0;
      skipFrom = ts;
      skipTo = te;
    }
  } else if (hasHook) {
    // Legacy single-beat opener (frame + VO together) — old specs with no teaser fields.
    const hookDur = (spec.audio.hook_duration_s ?? HOOK_SECONDS) + INSERT_PAD;
    items.push({
      kind: "insert",
      freezeSec: peak,
      durSec: hookDur,
      url: spec.audio.hook_url ?? null,
      text: spec.hook_text || spec.title,
    });
  }

  // The body (the beat AFTER the cold open) must never open mid-sentence. This covers
  // both hand-over paths: rolling on from the teaser, and flash-forwarding back to the
  // top of the clip where t_in may land anywhere.
  bodyStart = snapBodyStart(spec, bodyStart);

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
  //    cursor starts at bodyStart: the v2 cold open may have already carried the viewer
  //    past the money line, in which case we roll on from there instead of rewinding.
  // Emit a source run, splitting it around the already-played teaser span so that span
  // is never repeated. Runs shorter than 0.25s after the split are dropped rather than
  // rendered as a flicker.
  const MIN_RUN = 0.25;
  const pushSource = (from: number, to: number): void => {
    const emit = (a: number, b: number) => {
      if (b - a >= MIN_RUN) items.push({ kind: "source", startSec: a, endSec: b, durSec: b - a });
    };
    if (skipFrom == null || skipTo == null || to <= skipFrom || from >= skipTo) {
      emit(from, to);
      return;
    }
    emit(from, Math.min(to, skipFrom));
    emit(Math.max(from, skipTo), to);
  };
  // A reaction anchored inside the skipped span has lost its landing spot — the line it
  // reacts to never plays in the body. Push it to just after the span instead of dropping
  // it, so we keep the take without it appearing to answer nothing.
  const afterSkip = (t: number): number =>
    skipFrom != null && skipTo != null && t > skipFrom && t < skipTo ? skipTo : t;

  let cursor = bodyStart;
  for (const r of valid) {
    const at = afterSkip(r.at);
    // Drop any reaction that sits before where the body actually begins — it either
    // already played inside the cold open or was skipped over by it.
    if (at <= cursor + 0.8) continue;
    if (at > cursor + 0.05) pushSource(cursor, at);
    items.push({ kind: "insert", freezeSec: at, durSec: r.dur, url: r.url, text: r.text });
    cursor = at;
  }
  if (cursor < C - 0.05) {
    const endSec = snapClipEnd(spec, cursor);
    // Only render a trailing speaker run if it is a sensible length ending on a clean
    // sentence. If the clean end lands at/near the last take, cut straight to the
    // takeaway rather than flash a fraction of a rolled/unfinished sentence.
    if (endSec > cursor + 1.0) pushSource(cursor, endSec);
  }
  items.push({ kind: "takeaway", durSec: takeawayLen });

  // LOOP FRAME — the proven Shorts structure ends by flowing back into the first frame.
  // Shorts auto-replay, so finishing on a static takeaway card makes the loop land as a
  // hard visual mismatch and reads as "the end". Holding the SAME frame we opened on for
  // a beat makes the replay a match cut instead. No VO, no whoosh.
  if (hasTeaser) {
    items.push({ kind: "insert", freezeSec: peak, durSec: 0.5, url: null, text: "", flash: true, loop: true });
  }

  const totalSec = items.reduce((a, i) => a + i.durSec, 0);
  return { items, totalSec };
}
