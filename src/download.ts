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

  // Extract mono, low-bitrate audio for transcription.
  await run("ffmpeg", ["-y", "-i", videoPath, "-vn", "-ac", "1", "-b:a", "48k", audioPath]);

  return { videoPath, audioPath, workDir, title, durationS };
}
