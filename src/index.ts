import fs from "node:fs/promises";
import express from "express";
import { RenderSpecSchema } from "./types.js";
import { renderClip } from "./render.js";
import { downloadUrl, extractAudio, discover } from "./download.js";
import { pulse } from "./pulse.js";
import { putToSignedUrl } from "./supabase.js";
import { SERVE_DIR } from "./serve.js";
import * as youtube from "./youtube.js";

const app = express();
app.use(express.json({ limit: "5mb" }));

// Serve pre-cut clip sections over localhost so the renderer reads them fast.
app.use("/local", express.static(SERVE_DIR));

const PORT = Number(process.env.PORT || 8080);
const WORKER_SECRET = process.env.RENDER_WORKER_SECRET || "";

// Bump this on every worker build. /health echoes it so we can prove which build is
// actually live (independent of any deploy dashboard). audio_sizecheck=true means the
// download.ts measured-size audio re-encode (final47+) is present in this build.
const BUILD = "final73-coldopen-v2";

function authed(req: express.Request): boolean {
  if (!WORKER_SECRET) return true; // allow if unset (local dev)
  const h = req.header("authorization") || "";
  return h === `Bearer ${WORKER_SECRET}`;
}

// ---------------------------------------------------------------------------
// Render concurrency gate — how many WHOLE clips render at once. Each 1080p render
// now uses several CPU cores internally (REMOTION_CONCURRENCY in render.ts), so we
// serialise clips by default (1 at a time): this keeps peak memory bounded AND still
// renders each clip fast across cores, and it finishes each clip sooner (so its signed
// URLs are less likely to expire while it waits). Firing a whole batch at once exhausts
// memory/PIDs (spawn EAGAIN) and crashes the worker. Raise RENDER_CONCURRENCY only if
// you add a lot of RAM (and then also lower REMOTION_CONCURRENCY to match).
const MAX_RENDERS = Math.max(1, Number(process.env.RENDER_CONCURRENCY || 1));
let activeRenders = 0;
const renderWaiters: Array<() => void> = [];
function acquireRenderSlot(): Promise<void> {
  if (activeRenders < MAX_RENDERS) {
    activeRenders++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => renderWaiters.push(resolve));
}
function releaseRenderSlot(): void {
  const next = renderWaiters.shift();
  if (next) {
    next(); // hand this slot straight to the next waiter (activeRenders unchanged)
  } else {
    activeRenders = Math.max(0, activeRenders - 1);
  }
}

app.get("/health", (_req, res) =>
  res.json({ ok: true, service: "signal-render-worker", build: BUILD, audio_sizecheck: true })
);

// ---------------------------------------------------------------------------
// PUBLIC pages for the TikTok app registration. These deliberately live on the
// worker, NOT the Studio: the Studio's host returns empty bodies to non-browser
// clients (bot protection), so TikTok's automated verifier can never read them.
// This is a plain Express server, so verifier + reviewers both get real content.
// All routes below are intentionally UNAUTHENTICATED.
// ---------------------------------------------------------------------------
const STUDIO_URL = (process.env.STUDIO_URL || "https://signal-studio-scribe.lovable.app").replace(/\/+$/, "");

/**
 * TikTok site-verification signature files. TikTok issues a DIFFERENT file per
 * property (per URL prefix / domain you register), named tiktok<CODE>.txt and
 * containing "tiktok-developers-site-verification=<CODE>" — the same CODE in both.
 * So rather than hard-coding one hash (and redeploying every time TikTok issues a
 * new property), we derive the body from the requested filename. Any valid TikTok
 * verification file therefore resolves automatically, no redeploy needed.
 * Deliberately unauthenticated, plain text, no redirect.
 */
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  const m = /^\/tiktok([A-Za-z0-9_-]{8,128})\.txt$/.exec(req.path);
  if (!m) return next();
  console.log(`[tiktok] served verification file ${req.path}`);
  res
    .set("Content-Type", "text/plain; charset=utf-8")
    .send(`tiktok-developers-site-verification=${m[1]}`);
});

const legalPage = (title: string, bodyHtml: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — nibs</title><meta name="robots" content="noindex">
<style>body{background:#0f1113;color:#d4d4d4;font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;margin:0}
.wrap{max-width:720px;margin:0 auto;padding:48px 24px}h1{color:#fff;font-size:28px;margin:0 0 24px}
h2{color:#fff;font-size:18px;margin:28px 0 6px}a{color:#F5A623}
footer{margin-top:56px;padding-top:20px;border-top:1px solid rgba(255,255,255,.1);font-size:12px;color:#8A9099}</style>
</head><body><div class="wrap"><h1>${title}</h1>${bodyHtml}
<footer>Operated by Media68 Ltd. Contact: ytrealityjuice@gmail.com</footer></div></body></html>`;

app.get("/terms", (_req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8").send(
    legalPage(
      "Terms of Service",
      `<p><strong>Last updated:</strong> 18 July 2026</p>
<p>This tool ("nibs") is a private, internal content-production tool operated by Media68 Ltd. It is not a public consumer service and there is no public sign-up.</p>
<h2>1. Access</h2><p>Access is limited to authorised operators of Media68 Ltd. Unauthorised access is prohibited.</p>
<h2>2. Purpose</h2><p>The tool is used to produce, schedule and publish video content to the operator's own connected accounts (for example YouTube and TikTok).</p>
<h2>3. Operator responsibility</h2><p>The operator is responsible for the content they publish through the tool and for complying with the terms and policies of any connected platform.</p>
<h2>4. No warranty</h2><p>The service is provided "as is" with no warranty of any kind. Media68 Ltd is not liable for platform outages, third-party API changes, or any resulting loss.</p>
<h2>5. Contact</h2><p>Questions about these terms: <a href="mailto:ytrealityjuice@gmail.com">ytrealityjuice@gmail.com</a>.</p>`
    )
  );
});

app.get("/privacy", (_req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8").send(
    legalPage(
      "Privacy Policy",
      `<p><strong>Last updated:</strong> 18 July 2026</p>
<p>nibs is a private internal tool operated by Media68 Ltd. This policy describes what data the tool handles.</p>
<h2>1. No public users</h2><p>We do not collect personal data from members of the public. There is no public sign-up.</p>
<h2>2. Connected platform accounts</h2><p>When an authorised operator connects a third-party account (such as YouTube or TikTok), we store the OAuth tokens issued to us (including the refresh token) and an account identifier. These are used solely so the tool can upload and schedule content to that operator's own account.</p>
<h2>3. Operator content</h2><p>We store the operator's own video source material, transcripts, generated copy, and the performance analytics of the operator's own channels.</p>
<h2>4. Data belonging to viewers</h2><p>We do not collect, store, or process personal data belonging to viewers or other users of the connected platforms.</p>
<h2>5. Sharing</h2><p>We do not sell, rent, or share data with third parties. Data is processed only by the infrastructure providers used to run the tool: hosting, database and storage, and the AI and voice APIs used to generate content.</p>
<h2>6. Credential storage</h2><p>OAuth credentials are stored with restricted server-side access only.</p>
<h2>7. Revoking access</h2><p>An operator can disconnect an account inside the tool at any time, and can additionally revoke access directly in TikTok settings (Manage app permissions) or Google account security settings. Revoking access immediately stops the tool from being able to post to that account.</p>
<h2>8. Retention</h2><p>Connection credentials are kept until the account is disconnected. Produced media and working data are routinely purged.</p>
<h2>9. Contact</h2><p>Privacy requests, including deletion: <a href="mailto:ytrealityjuice@gmail.com">ytrealityjuice@gmail.com</a>.</p>`
    )
  );
});

/**
 * TikTok OAuth callback. TikTok redirects the browser here after the operator
 * approves. We do NOT hold the TikTok client secret on the worker — we forward
 * the code+state to the Studio (server-to-server, worker secret), which verifies
 * the state, exchanges the code and stores the refresh token. Then we bounce the
 * browser back to the Studio.
 */
app.get("/tiktok/callback", async (req, res) => {
  const code = req.query.code ? String(req.query.code) : "";
  const state = req.query.state ? String(req.query.state) : "";
  const oauthErr = req.query.error ? String(req.query.error) : "";
  const desc = req.query.error_description ? String(req.query.error_description) : "";
  const back = (status: "ok" | "error", message?: string) => {
    const qs = new URLSearchParams({ tiktok: status });
    if (message) qs.set("message", message.slice(0, 300));
    res.redirect(302, `${STUDIO_URL}/voices?${qs.toString()}`);
  };
  if (oauthErr) return back("error", desc || oauthErr);
  if (!code || !state) return back("error", "Missing code or state");
  try {
    const r = await fetch(`${STUDIO_URL}/api/tiktok/exchange`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WORKER_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code, state }),
    });
    const text = await r.text();
    let j: { ok?: boolean; error?: string } = {};
    try {
      j = JSON.parse(text);
    } catch {
      /* non-JSON */
    }
    if (!r.ok || j.error) return back("error", j.error || `Studio ${r.status}: ${text.slice(0, 200)}`);
    console.log("[tiktok] connected via worker callback");
    return back("ok");
  } catch (err: unknown) {
    return back("error", (err as Error)?.message || "exchange failed");
  }
});

/**
 * Pulse — the demand signal for discovery v2. Returns momentum-ranked AI/tech stories
 * surging right now (Hacker News + AI news RSS). Body: { since_hours? } (default 72).
 * The Studio clusters + scores these and turns the hot ones into YouTube clip searches.
 */
app.post("/pulse", async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: "unauthorized" });
  try {
    const sinceHours = Number(req.body?.since_hours) || 72;
    const items = await pulse(sinceHours);
    res.json({ items, count: items.length });
  } catch (err: unknown) {
    const msg = (err as Error)?.message || String(err);
    console.error("[pulse] failed", msg);
    res.status(500).json({ error: msg });
  }
});

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

/**
 * Flip a YouTube video's privacy (used for the Studio "Make Public" button).
 * Body: { video_id | url, privacy? }  (privacy defaults to "public").
 * Credentials live only here; the Studio calls this instead of holding a token.
 */
app.post("/youtube/publish", async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: "unauthorized" });
  const { video_id, url, privacy, credentials } = req.body ?? {};
  if (!youtube.isConfigured(credentials)) {
    return res.status(503).json({ error: "YouTube not configured (no credentials and YT_* env missing)" });
  }
  const id = youtube.parseVideoId(String(video_id || url || ""));
  if (!id) return res.status(400).json({ error: "video_id or url (a valid YouTube link) required" });
  const target = (privacy as youtube.Privacy) || "public";
  try {
    await youtube.setPrivacy(id, target, credentials);
    console.log(`[youtube] set ${id} -> ${target}`);
    res.json({ ok: true, video_id: id, privacy: target, url: `https://youtu.be/${id}` });
  } catch (err: unknown) {
    const msg = (err as Error)?.message || String(err);
    console.error("[youtube/publish] failed", msg);
    res.status(500).json({ error: msg });
  }
});

/**
 * Cancel a scheduled release (Studio "Cancel" button). Clears the YouTube
 * publishAt and pins the video Private so it will not auto-publish.
 * Body: { video_id | url }
 */
app.post("/youtube/unschedule", async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: "unauthorized" });
  const { video_id, url, credentials } = req.body ?? {};
  if (!youtube.isConfigured(credentials)) {
    return res.status(503).json({ error: "YouTube not configured (no credentials and YT_* env missing)" });
  }
  const id = youtube.parseVideoId(String(video_id || url || ""));
  if (!id) return res.status(400).json({ error: "video_id or url (a valid YouTube link) required" });
  try {
    await youtube.unschedule(id, credentials);
    console.log(`[youtube] unscheduled ${id} (now private, publishAt cleared)`);
    res.json({ ok: true, video_id: id, url: `https://youtu.be/${id}` });
  } catch (err: unknown) {
    const msg = (err as Error)?.message || String(err);
    console.error("[youtube/unschedule] failed", msg);
    res.status(500).json({ error: msg });
  }
});

/**
 * Read real YouTube status for a set of videos (privacy + scheduled publishAt), so the
 * Studio can resync its Scheduled list with changes made directly on YouTube.
 * Body: { video_ids: string[] }  ->  { statuses: [{id, privacyStatus, publishAt}], requested }
 * A requested id absent from `statuses` means that video was deleted / is inaccessible.
 */
app.post("/youtube/status", async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: "unauthorized" });
  const { credentials } = req.body ?? {};
  if (!youtube.isConfigured(credentials)) {
    return res.status(503).json({ error: "YouTube not configured (no credentials and YT_* env missing)" });
  }
  const raw = (req.body?.video_ids ?? []) as unknown[];
  const ids = Array.isArray(raw) ? raw.map(String).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: "video_ids[] required" });
  try {
    const statuses = await youtube.getVideoStatuses(ids, credentials);
    res.json({ statuses, requested: ids.length });
  } catch (err: unknown) {
    const msg = (err as Error)?.message || String(err);
    console.error("[youtube/status] failed", msg);
    res.status(500).json({ error: msg });
  }
});

/**
 * Enumerate the channel's OWN upcoming scheduled uploads directly from YouTube
 * (private/unlisted videos with a future publishAt). This is the source of truth for
 * the Studio Scheduled page — independent of our local records, so it still finds
 * videos whose local rows were purged (48h cleanup) or never recorded.
 * Body: { credentials? }  ->  { scheduled: [{id, title, publishAt, privacyStatus, thumbnail}], count }
 */
app.post("/youtube/scheduled", async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: "unauthorized" });
  const { credentials } = req.body ?? {};
  if (!youtube.isConfigured(credentials)) {
    return res.status(503).json({ error: "YouTube not configured (no credentials and YT_* env missing)" });
  }
  try {
    const scheduled = await youtube.listScheduled(credentials);
    res.json({ scheduled, count: scheduled.length });
  } catch (err: unknown) {
    const msg = (err as Error)?.message || String(err);
    console.error("[youtube/scheduled] failed", msg);
    res.status(500).json({ error: msg });
  }
});

app.post("/render", async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: "unauthorized" });

  const parsed = RenderSpecSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid spec", details: parsed.error.flatten() });
  }
  const spec = parsed.data;

  // Async mode: ack immediately, POST result to callback_url when done. The render
  // itself waits for a concurrency slot so a big batch can't crash the worker.
  if (spec.callback_url) {
    res.status(202).json({ status: "accepted", clip_candidate_id: spec.clip_candidate_id });
    console.log(
      `[render] QUEUED ${spec.clip_candidate_id} (active=${activeRenders}, waiting=${renderWaiters.length})`
    );
    acquireRenderSlot().then(() => {
      const started = Date.now();
      console.log(`[render] START ${spec.clip_candidate_id} → callback ${spec.callback_url}`);
      return renderClip(spec)
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
        })
        .finally(() => releaseRenderSlot());
    });
    return;
  }

  // Sync mode: render and return (fine for single-user Phase 0). Also gated.
  await acquireRenderSlot();
  try {
    const result = await renderClip(spec);
    res.json({ status: "done", ...result });
  } catch (err: unknown) {
    console.error("[render] failed", err);
    res.status(500).json({ status: "failed", error: String((err as Error)?.message || err) });
  } finally {
    releaseRenderSlot();
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
  console.log(`signal-render-worker listening on :${PORT} [build ${BUILD}]`);
  // Log the yt-dlp version at boot so we can confirm the nightly build is live.
  import("node:child_process").then(({ exec }) =>
    exec("yt-dlp --version", (_e, stdout) =>
      console.log(`[yt-dlp] version ${(stdout || "unknown").trim()}`)
    )
  );
  startTickHeartbeat();
});

/**
 * Pipeline heartbeat. The Studio pipeline advances server-side via POST /api/tick,
 * but something has to call it on a schedule. This always-on worker already holds
 * the shared RENDER_WORKER_SECRET, so it pings the Studio's /api/tick regularly,
 * letting clips run to completion with no browser open. Overlap-guarded.
 */
function startTickHeartbeat(): void {
  const tickUrl = process.env.STUDIO_TICK_URL || "https://signal-studio-scribe.lovable.app/api/tick";
  const intervalMs = Number(process.env.TICK_INTERVAL_MS || 120000);
  if (!WORKER_SECRET || !tickUrl) {
    console.log("[tick] heartbeat disabled (no RENDER_WORKER_SECRET or STUDIO_TICK_URL)");
    return;
  }
  let ticking = false;
  const fire = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(intervalMs - 5000, 30000));
      const r = await fetch(tickUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${WORKER_SECRET}`, "content-type": "application/json" },
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      const body = await r.text().catch(() => "");
      if (r.status !== 200) console.warn(`[tick] ${r.status}: ${body.slice(0, 160)}`);
    } catch (err) {
      console.warn("[tick] failed", (err as Error)?.message || err);
    } finally {
      ticking = false;
    }
  };
  setInterval(fire, intervalMs);
  console.log(`[tick] heartbeat every ${intervalMs / 1000}s -> ${tickUrl}`);
}
