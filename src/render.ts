import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { bundle } from "@remotion/bundler";
import { ensureBrowser, renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { parseBuffer } from "music-metadata";
import type { RenderSpec } from "./types.js";
import { putToSignedUrl, uploadWithServiceRole } from "./supabase.js";
import { SERVE_DIR } from "./serve.js";
import * as youtube from "./youtube.js";

/** Run ffmpeg, rejecting with the tail of stderr on failure. */
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-500)}`))
    );
  });
}

/**
 * The big win for render speed: the source video lives in Supabase, so rendering
 * straight from its signed URL means OffthreadVideo does a *remote range-request seek
 * for every single frame* — deep into a long file, that stalls and trips the timeout.
 *
 * Instead we cut just the [t_in, t_out] section once (ffmpeg fast-seeks to a keyframe
 * ~2s early, then accurate-seeks in), write it to a local dir the worker serves over
 * localhost, and rebase the spec to be 0-based. OffthreadVideo then reads a tiny local
 * file — fast seeks, no per-frame network. Returns the temp file path for cleanup.
 */
async function precutSource(spec: RenderSpec): Promise<string | null> {
  if (!/^https?:\/\//i.test(spec.source_url)) return null;
  const base = Math.max(0, spec.t_in);
  const clipLen = Math.max(0.5, spec.t_out - spec.t_in);
  const pre = Math.min(2, base);
  const name = `${randomUUID()}.mp4`;
  const cutPath = path.join(SERVE_DIR, name);
  const port = Number(process.env.PORT || 8080);
  console.log(
    `[render] pre-cutting ${base.toFixed(1)}s..${(base + clipLen).toFixed(1)}s from remote source`
  );
  await runFfmpeg([
    "-y",
    "-ss",
    String(base - pre),
    "-i",
    spec.source_url,
    "-ss",
    String(pre),
    "-t",
    String(clipLen),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    cutPath,
  ]);
  // Rebase: the cut file is now a 0-based source. Shift caption word times too.
  spec.captions = spec.captions.map((w) => ({ ...w, start: w.start - base, end: w.end - base }));
  spec.t_out = clipLen;
  spec.t_in = 0;
  spec.source_url = `http://127.0.0.1:${port}/local/${name}`;
  console.log(`[render] pre-cut done -> ${spec.source_url}`);
  return cutPath;
}

/** Fetch an audio file and return its duration in seconds (undefined on failure). */
async function audioDuration(url?: string | null): Promise<number | undefined> {
  if (!url) return undefined;
  try {
    const res = await fetch(url);
    if (!res.ok) return undefined;
    const buf = Buffer.from(await res.arrayBuffer());
    const meta = await parseBuffer(buf, "audio/mpeg");
    return meta.format.duration ?? undefined;
  } catch {
    return undefined;
  }
}

/** Measure the real length of every Matt audio clip so nothing is cut off or over-talked. */
async function measureAudioDurations(spec: RenderSpec): Promise<void> {
  const hook = await audioDuration(spec.audio.hook_url);
  if (hook) spec.audio.hook_duration_s = hook;
  const takeaway = await audioDuration(spec.audio.takeaway_url);
  if (takeaway) spec.audio.takeaway_duration_s = takeaway;
  for (const it of spec.audio.interjections) {
    const d = await audioDuration(it.url);
    if (d && d > 0) it.duration_s = d;
  }
}

// Bundle once, reuse across requests (cold start ~ a few seconds).
let serveUrlPromise: Promise<string> | null = null;
function getServeUrl(): Promise<string> {
  if (!serveUrlPromise) {
    serveUrlPromise = (async () => {
      await ensureBrowser();
      return bundle({
        entryPoint: path.join(process.cwd(), "src/remotion/index.ts"),
        // Load Space Grotesk for the branded look.
        webpackOverride: (c) => c,
      });
    })();
  }
  return serveUrlPromise;
}

export interface RenderResult {
  clip_candidate_id: string;
  output_path: string; // storage path
  thumbnail_path: string;
  duration_s: number;
  bytes: number;
  youtube_video_id?: string; // set if auto-uploaded to YouTube
  youtube_error?: string; // set if auto-upload was attempted but failed
}

export async function renderClip(spec: RenderSpec): Promise<RenderResult> {
  const serveUrl = await getServeUrl();
  // Measure real audio lengths so the hook/takeaway cards and ducking fit exactly.
  await measureAudioDurations(spec);
  // Pre-cut the source section locally so rendering doesn't seek a huge remote file.
  let cutPath: string | null = null;
  try {
    cutPath = await precutSource(spec);
  } catch (e) {
    console.warn("[render] pre-cut failed, using remote source:", (e as Error).message);
    cutPath = null;
  }
  const inputProps = { spec };

  // Software rendering (Railway has no GPU) + generous per-frame timeout.
  const chromiumOptions = { gl: "swiftshader" as const };
  const FRAME_TIMEOUT = 120_000;
  // Cap concurrency so a small container doesn't thrash / OOM. Default 1 (safest on
  // small Railway containers); raise via RENDER_CONCURRENCY if you give it more RAM.
  const concurrency = Number(process.env.RENDER_CONCURRENCY || 1);
  // Render at 2/3 scale so 1080x1920 becomes 720x1280 — far less encoder memory,
  // layout/fonts stay proportional automatically. Set RENDER_SCALE=1 once you add RAM.
  const scale = Number(process.env.RENDER_SCALE || 2 / 3);
  // Cap Remotion's OffthreadVideo frame cache. In a container Remotion mis-detects
  // available RAM and sizes this cache too large, so on a video-heavy render it grows
  // until the Chrome page thrashes and freezes ("timeout evaluating page function").
  // An explicit modest cap keeps memory flat. Tune via OFFTHREAD_CACHE_MB.
  const offthreadVideoCacheSizeInBytes =
    Number(process.env.OFFTHREAD_CACHE_MB || 256) * 1024 * 1024;

  const composition = await selectComposition({
    serveUrl,
    id: "SignalClip",
    inputProps,
    chromiumOptions,
    timeoutInMilliseconds: FRAME_TIMEOUT,
  });

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "signal-"));
  const outFile = path.join(workDir, "clip.mp4");
  const thumbFile = path.join(workDir, "thumb.jpeg");

  console.log(
    `[render] composition ${composition.durationInFrames} frames @ ${composition.fps}fps, concurrency=${concurrency}, scale=${scale.toFixed(3)} (${Math.round(composition.width * scale)}x${Math.round(composition.height * scale)})`
  );
  let lastPct = -1;
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation: outFile,
    inputProps,
    crf: 23,
    concurrency,
    scale,
    offthreadVideoCacheSizeInBytes,
    chromiumOptions,
    timeoutInMilliseconds: FRAME_TIMEOUT,
    onProgress: ({ renderedFrames }) => {
      const pct = Math.floor((renderedFrames / composition.durationInFrames) * 100);
      if (pct >= lastPct + 10) {
        lastPct = pct;
        console.log(`[render] ${pct}% (${renderedFrames}/${composition.durationInFrames})`);
      }
    },
  });

  await renderStill({
    composition,
    serveUrl,
    output: thumbFile,
    frame: Math.floor(composition.durationInFrames * 0.5),
    inputProps,
    imageFormat: "jpeg",
    scale,
    offthreadVideoCacheSizeInBytes,
    chromiumOptions,
    timeoutInMilliseconds: FRAME_TIMEOUT,
  });

  const id = spec.clip_candidate_id || randomUUID();
  const mp4 = await fs.readFile(outFile);
  const thumb = await fs.readFile(thumbFile);

  let output_path: string;
  let thumbnail_path: string;

  if (spec.upload) {
    // Preferred: PUT to signed URLs from the edge function (no keys on the worker).
    await putToSignedUrl(spec.upload.mp4_put_url, mp4, "video/mp4");
    await putToSignedUrl(spec.upload.thumb_put_url, thumb, "image/jpeg");
    output_path = spec.upload.mp4_path;
    thumbnail_path = spec.upload.thumb_path;
  } else {
    // Fallback: direct upload with a service_role key (only if env is set).
    output_path = await uploadWithServiceRole(`clips/${id}.mp4`, mp4, "video/mp4");
    thumbnail_path = await uploadWithServiceRole(`clips/${id}.jpeg`, thumb, "image/jpeg");
  }

  // Optional: auto-upload to YouTube (Unlisted by default). Never fails the render —
  // the clip is already safely in Supabase; a YouTube hiccup is reported, not fatal.
  let youtube_video_id: string | undefined;
  let youtube_error: string | undefined;
  if (spec.publish && youtube.isConfigured()) {
    try {
      console.log(`[youtube] uploading "${spec.publish.title}" (${spec.publish.privacy})`);
      youtube_video_id = await youtube.uploadVideo({
        buffer: mp4,
        title: spec.publish.title,
        description: spec.publish.description,
        tags: spec.publish.tags,
        privacyStatus: spec.publish.privacy,
      });
      console.log(`[youtube] uploaded -> https://youtu.be/${youtube_video_id}`);
    } catch (e) {
      youtube_error = (e as Error)?.message || String(e);
      console.error("[youtube] upload failed:", youtube_error);
    }
  } else if (spec.publish && !youtube.isConfigured()) {
    console.log("[youtube] publish requested but YT_* env not set — skipping upload");
  }

  await fs.rm(workDir, { recursive: true, force: true });
  if (cutPath) await fs.rm(cutPath, { force: true }).catch(() => {});

  return {
    clip_candidate_id: id,
    output_path,
    thumbnail_path,
    duration_s: composition.durationInFrames / composition.fps,
    bytes: mp4.byteLength,
    youtube_video_id,
    youtube_error,
  };
}
