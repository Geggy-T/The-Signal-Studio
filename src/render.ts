import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { bundle } from "@remotion/bundler";
import { ensureBrowser, renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import type { RenderSpec } from "./types.js";
import { uploadToStorage } from "./supabase.js";

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
  const inputProps = { spec };

  const composition = await selectComposition({
    serveUrl,
    id: "SignalClip",
    inputProps,
  });

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "signal-"));
  const outFile = path.join(workDir, "clip.mp4");
  const thumbFile = path.join(workDir, "thumb.jpeg");

  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation: outFile,
    inputProps,
    // 9:16 shorts: keep it crisp but not huge.
    crf: 20,
    concurrency: null, // let Remotion decide based on the machine
  });

  await renderStill({
    composition,
    serveUrl,
    output: thumbFile,
    frame: Math.floor(composition.durationInFrames * 0.5),
    inputProps,
    imageFormat: "jpeg",
  });

  const id = spec.clip_candidate_id || randomUUID();
  const mp4 = await fs.readFile(outFile);
  const thumb = await fs.readFile(thumbFile);

  const output_path = await uploadToStorage(`clips/${id}.mp4`, mp4, "video/mp4");
  const thumbnail_path = await uploadToStorage(`clips/${id}.jpeg`, thumb, "image/jpeg");

  await fs.rm(workDir, { recursive: true, force: true });

  return {
    clip_candidate_id: id,
    output_path,
    thumbnail_path,
    duration_s: composition.durationInFrames / composition.fps,
    bytes: mp4.byteLength,
  };
}
