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
          at: z.number(), // seconds into the CLIP where the interjection starts
          url: z.string().url(),
          duration_s: z.number().default(3), // ducking window; worker sets to the real audio length
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

/**
 * Segment lengths, driven by the MEASURED audio durations so nothing gets cut off.
 * Used by both the composition (SignalClip) and calculateMetadata (Root) so they agree.
 */
export function computeSegmentSeconds(spec: RenderSpec) {
  const hookAudio = spec.audio.hook_duration_s ?? HOOK_SECONDS;
  const takeawayAudio = spec.audio.takeaway_duration_s ?? TAKEAWAY_SECONDS;
  const hookLen = Math.max(MIN_HOOK_SECONDS, hookAudio + SEGMENT_PAD);
  const takeawayLen = Math.max(MIN_TAKEAWAY_SECONDS, takeawayAudio + SEGMENT_PAD);
  const clipLen = Math.max(0.5, spec.t_out - spec.t_in);
  return { hookLen, clipLen, takeawayLen, total: hookLen + clipLen + takeawayLen };
}
