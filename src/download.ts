import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

/** Run a CLI command, rejecting with stderr on non-zero exit. */
function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-600)}`))
    );
  });
}

export interface DownloadResult {
  videoPath: string;
  audioPath: string;
  workDir: string;
  title: string;
  durationS: number | null;
}

/**
 * Download a video URL (YouTube or any yt-dlp-supported site) as:
 *  - video.mp4  (capped at 720p to keep size sane, for the render)
 *  - audio.mp3  (mono, low-bitrate, for cheap/small transcription under Groq's 25MB cap)
 *
 * NOTE: only use for rights-clean sources you are cleared to use.
 */
export async function downloadUrl(url: string): Promise<DownloadResult> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "ingest-"));
  const videoPath = path.join(workDir, "video.mp4");
  const audioPath = path.join(workDir, "audio.mp3");

  // Fetch metadata (title, duration) without downloading.
  let title = "";
  let durationS: number | null = null;
  try {
    const meta = await run("yt-dlp", ["--no-playlist", "--dump-single-json", "--no-warnings", url]);
    const j = JSON.parse(meta) as { title?: string; duration?: number };
    title = j.title ?? "";
    durationS = typeof j.duration === "number" ? j.duration : null;
  } catch {
    // Non-fatal — continue to download.
  }

  // Download a <=720p mp4 (merge if needed).
  await run("yt-dlp", [
    "--no-playlist",
    "--no-warnings",
    "-f",
    "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/b[ext=mp4]/b",
    "--merge-output-format",
    "mp4",
    "-o",
    videoPath,
    url,
  ]);

  // Extract mono, low-bitrate audio for transcription (16kHz is what Whisper uses).
  await run("ffmpeg", ["-y", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", audioPath]);

  return { videoPath, audioPath, workDir, title, durationS };
}

/**
 * Extract a small mono audio track (mp3) straight from a media URL (an uploaded
 * file's signed URL, or a direct media link) so transcription stays tiny even for
 * long sources. ffmpeg reads the https URL directly.
 */
/** Run a command, resolve with whatever stdout we got, killing it after timeoutMs. */
function runSoft(cmd: string, args: string[], timeoutMs = 20000): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("error", () => {
      clearTimeout(timer);
      resolve(out);
    });
    p.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

export interface DiscoveredItem {
  url: string;
  title: string;
  uploader: string;
  view_count: number | null;
  like_count: number | null;
  timestamp: number | null; // unix seconds
  duration: number | null;
  thumbnail: string | null;
  source: string;
}

/**
 * Discover recent videos + metadata from a list of TikTok creator/hashtag URLs via
 * yt-dlp (no paid API). Resilient: a failing source is skipped, partial output kept.
 */
export async function discover(
  sources: string[],
  perSource = 6,
  budgetMs = 65000
): Promise<DiscoveredItem[]> {
  const items: DiscoveredItem[] = [];
  const deadline = Date.now() + budgetMs;
  for (const src of sources) {
    if (Date.now() > deadline) {
      console.warn(`[discover] time budget reached; stopping at ${items.length} items`);
      break;
    }
    const out = await runSoft(
      "yt-dlp",
      [
        "--no-warnings",
        "--ignore-errors",
        "--dump-json",
        "--playlist-end",
        String(perSource),
        src,
      ],
      18000
    );
    for (const line of out.split("\n")) {
      const t = line.trim();
      if (!t || t[0] !== "{") continue;
      try {
        const j = JSON.parse(t) as Record<string, unknown>;
        const url = String(j.webpage_url || j.url || j.original_url || "");
        if (!url) continue;
        items.push({
          url,
          title: String(j.title || j.description || "").slice(0, 300),
          uploader: String(j.uploader || j.uploader_id || j.channel || ""),
          view_count: typeof j.view_count === "number" ? j.view_count : null,
          like_count: typeof j.like_count === "number" ? j.like_count : null,
          timestamp: typeof j.timestamp === "number" ? j.timestamp : null,
          duration: typeof j.duration === "number" ? j.duration : null,
          thumbnail: typeof j.thumbnail === "string" ? j.thumbnail : null,
          source: src,
        });
      } catch {
        /* skip bad line */
      }
    }
  }
  return items;
}

export async function extractAudio(
  sourceUrl: string
): Promise<{ audioPath: string; workDir: string }> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "audio-"));
  const audioPath = path.join(workDir, "audio.mp3");
  await run("ffmpeg", [
    "-y",
    "-i",
    sourceUrl,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-b:a",
    "32k",
    audioPath,
  ]);
  return { audioPath, workDir };
}
