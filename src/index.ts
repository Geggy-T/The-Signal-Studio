import fs from "node:fs/promises";
import express from "express";
import { RenderSpecSchema } from "./types.js";
import { renderClip } from "./render.js";
import { downloadUrl, extractAudio, discover } from "./download.js";
import { putToSignedUrl } from "./supabase.js";
import { SERVE_DIR } from "./serve.js";

const app = express();
app.use(express.json({ limit: "5mb" }));

// Serve pre-cut clip sections over localhost so the renderer reads them fast.
app.use("/local", express.static(SERVE_DIR));

const PORT = Number(process.env.PORT || 8080);
const WORKER_SECRET = process.env.RENDER_WORKER_SECRET || "";

function authed(req: express.Request): boolean {
  if (!WORKER_SECRET) return true; // allow if unset (local dev)
  const h = req.header("authorization") || "";
  return h === `Bearer ${WORKER_SECRET}`;
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "signal-render-worker" }));

/**
 * Local-download queue. The Studio enqueues web-video (YouTube etc.) downloads here;
 * a local agent running on the user's own machine polls /next-download, downloads with
 * their browser + home IP (sidesteps YouTube's server-side blocks), and PUTs the files
 * to the signed URLs. In-memory: fine for a single-user tool.
 */
interface DownloadJob {
  source_id: string;
  url: string;
  video_put_url: string;
  audio_put_url: string;
  queued_at: number;
}
const downloadQueue: DownloadJob[] = [];

app.post("/queue-download", (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: "unauthorized" });
  const { source_id, url, video_put_url, audio_put_url } = req.body ?? {};
  if (!source_id || !url || !video_put_url || !audio_put_url) {
    return res.status(400).json({ error: "source_id, url, video_put_url, audio_put_url required" });
  }
  downloadQueue.push({ source_id, url, video_put_url, audio_put_url, queued_at: Date.now() });
  console.log(`[queue] +1 (${downloadQueue.length} pending): ${url}`);
  res.json({ ok: true, pending: downloadQueue.length });
});

app.get("/next-download", (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: "unauthorized" });
  const job = downloadQueue.shift() ?? null;
  if (job) console.log(`[queue] -> local agent: ${job.url}`);
  res.json({ job });
});

/**
 * Trend discovery: given a list of TikTok creator/hashtag URLs, return recent videos
 * with metadata (views, likes, date, thumbnail) via yt-dlp. Body: { sources[], per_source? }
 */
app.post("/discover", async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: "unauthorized" });
  const { sources, per_source } = req.body ?? {};
  if (!Array.isArray(sources) || sources.length === 0) {
    return res.status(400).json({ error: "sources[] is required" });
  }
  try {
    const items = await discover(
      sources.map((s: unknown) => String(s)).slice(0, 25),
      Math.min(Math.max(Number(per_source) || 8, 1), 20)
    );
    console.log(`[discover] ${items.length} items from ${sources.length} sources`);
    res.json({ status: "done", items });
  } catch (err: unknown) {
    console.error("[discover] failed", err);
    res.status(500).json({ status: "failed", error: String((err as Error)?.message || err) });
  }
});

/**
 * Extract a small mono audio track from a media URL (an uploaded file's signed URL,
 * or a direct media link) and PUT it to a signed upload URL — so transcription stays
 * tiny even for long sources. Body: { source_url, audio_put_url }
 */
app.post("/extract-audio", async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: "unauthorized" });
  const { source_url, audio_put_url } = req.body ?? {};
  if (!source_url || !audio_put_url) {
    return res.status(400).json({ error: "source_url and audio_put_url are required" });
  }
  let workDir: string | null = null;
  try {
    const out = await extractAudio(String(source_url));
    workDir = out.workDir;
    const audioBuf = await fs.readFile(out.audioPath);
    await putToSignedUrl(String(audio_put_url), audioBuf, "audio/mpeg");
    res.json({ status: "done", audio_bytes: audioBuf.byteLength });
  } catch (err: unknown) {
    console.error("[extract-audio] failed", err);
    res.status(500).json({ status: "failed", error: String((err as Error)?.message || err) });
  } finally {
    if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

/**
 * Download a video URL (YouTube etc.) via yt-dlp and PUT the resulting video + audio
 * to the provided Supabase signed upload URLs. Only for rights-clean sources.
 * Body: { url, video_put_url, audio_put_url }
 */
app.post("/ingest-url", async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: "unauthorized" });
  const { url, video_put_url, audio_put_url } = req.body ?? {};
  if (!url || !video_put_url || !audio_put_url) {
    return res.status(400).json({ error: "url, video_put_url and audio_put_url are required" });
  }
  let workDir: string | null = null;
  try {
    const dl = await downloadUrl(String(url));
    workDir = dl.workDir;
    const videoBuf = await fs.readFile(dl.videoPath);
    const audioBuf = await fs.readFile(dl.audioPath);
    await putToSignedUrl(String(video_put_url), videoBuf, "video/mp4");
    await putToSignedUrl(String(audio_put_url), audioBuf, "audio/mpeg");
    res.json({
      status: "done",
      title: dl.title,
      duration_s: dl.durationS,
      video_bytes: videoBuf.byteLength,
      audio_bytes: audioBuf.byteLength,
    });
  } catch (err: unknown) {
    console.error("[ingest-url] failed", err);
    res.status(500).json({ status: "failed", error: String((err as Error)?.message || err) });
  } finally {
    if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

app.post("/render", async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: "unauthorized" });

  const parsed = RenderSpecSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid spec", details: parsed.error.flatten() });
  }
  const spec = parsed.data;

  // Async mode: ack immediately, POST result to callback_url when done.
  if (spec.callback_url) {
    res.status(202).json({ status: "accepted", clip_candidate_id: spec.clip_candidate_id });
    const started = Date.now();
    console.log(`[render] START ${spec.clip_candidate_id} → callback ${spec.callback_url}`);
    renderClip(spec)
      .then((result) => {
        console.log(
          `[render] DONE ${spec.clip_candidate_id} in ${((Date.now() - started) / 1000).toFixed(1)}s (${result.bytes} bytes)`
        );
        return postCallback(spec.callback_url!, { status: "done", ...result });
      })
      .catch((err) => {
        console.error(`[render] FAILED ${spec.clip_candidate_id}:`, err?.stack || err);
        return postCallback(spec.callback_url!, {
          status: "failed",
          clip_candidate_id: spec.clip_candidate_id,
          error: String(err?.message || err),
        });
      });
    return;
  }

  // Sync mode: render and return (fine for single-user Phase 0).
  try {
    const result = await renderClip(spec);
    res.json({ status: "done", ...result });
  } catch (err: unknown) {
    console.error("[render] failed", err);
    res.status(500).json({ status: "failed", error: String((err as Error)?.message || err) });
  }
});

async function postCallback(url: string, body: unknown): Promise<void> {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(WORKER_SECRET ? { authorization: `Bearer ${WORKER_SECRET}` } : {}),
      },
      body: JSON.stringify(body),
    });
    console.log(`[callback] POST ${url} -> ${r.status}`);
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      console.error(`[callback] non-OK ${r.status}: ${t.slice(0, 300)}`);
    }
  } catch (err) {
    console.error("[callback] fetch threw (URL unreachable?)", err);
  }
}

app.listen(PORT, () => {
  console.log(`signal-render-worker listening on :${PORT}`);
  // Log the yt-dlp version at boot so we can confirm the nightly build is live.
  import("node:child_process").then(({ exec }) =>
    exec("yt-dlp --version", (_e, stdout) =>
      console.log(`[yt-dlp] version ${(stdout || "unknown").trim()}`)
    )
  );
});
