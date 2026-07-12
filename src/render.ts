import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { bundle } from "@remotion/bundler";
import { ensureBrowser, renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { parseBuffer } from "music-metadata";
import type { RenderSpec } from "./types.js";
import { putToSignedUrl, uploadWithServiceRole } from "./supabase.js";

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
}

export async function renderClip(spec: RenderSpec): Promise<RenderResult> {
  const serveUrl = await getServeUrl();
  // Measure real audio lengths so the hook/takeaway cards and ducking fit exactly.
  await measureAudioDurations(spec);
  const inputProps = { spec };

  // Software rendering (Railway has no GPU) + generous per-frame timeout.
  const chromiumOptions = { gl: "swiftshader" as const };
  const FRAME_TIMEOUT = 120_000;
  // Cap concurrency so a small container doesn't thrash / OOM. Override via env.
  const concurrency = Number(process.env.RENDER_CONCURRENCY || 2);

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
    `[render] composition ${composition.durationInFrames} frames @ ${composition.fps}fps, concurrency=${concurrency}`
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

  await fs.rm(workDir, { recursive: true, force: true });

  return {
    clip_candidate_id: id,
    output_path,
    thumbnail_path,
    duration_s: composition.durationInFrames / composition.fps,
    bytes: mp4.byteLength,
  };
}
