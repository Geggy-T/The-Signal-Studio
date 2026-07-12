import fs from "node:fs/promises";
import express from "express";
import { RenderSpecSchema } from "./types.js";
import { renderClip } from "./render.js";
import { downloadUrl } from "./download.js";
import { putToSignedUrl } from "./supabase.js";

const app = express();
app.use(express.json({ limit: "5mb" }));

const PORT = Number(process.env.PORT || 8080);
const WORKER_SECRET = process.env.RENDER_WORKER_SECRET || "";

function authed(req: express.Request): boolean {
  if (!WORKER_SECRET) return true; // allow if unset (local dev)
  const h = req.header("authorization") || "";
  return h === `Bearer ${WORKER_SECRET}`;
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "signal-render-worker" }));

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
    renderClip(spec)
      .then((result) => postCallback(spec.callback_url!, { status: "done", ...result }))
      .catch((err) =>
        postCallback(spec.callback_url!, {
          status: "failed",
          clip_candidate_id: spec.clip_candidate_id,
          error: String(err?.message || err),
        })
      );
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
    await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(WORKER_SECRET ? { authorization: `Bearer ${WORKER_SECRET}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("[callback] failed", err);
  }
}

app.listen(PORT, () => console.log(`signal-render-worker listening on :${PORT}`));
