/**
 * YouTube publishing for Tech on Toast.
 *
 * No googleapis dependency — just the OAuth refresh-token flow plus the
 * Data API v3 resumable upload and a status update, over fetch. Credentials
 * live only on this worker (env), so the Studio never holds a Google token;
 * it calls the worker's /youtube/publish endpoint instead.
 *
 * Required env (set in Railway):
 *   YT_CLIENT_ID       OAuth client id
 *   YT_CLIENT_SECRET   OAuth client secret
 *   YT_REFRESH_TOKEN   refresh token for the @techontoast channel
 *                      (scopes: youtube.upload + youtube.force-ssl)
 * Optional:
 *   YT_CATEGORY_ID     default "28" (Science & Technology)
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const UPLOAD_URL =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";
const VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";
const CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels";
const PLAYLIST_ITEMS_URL = "https://www.googleapis.com/youtube/v3/playlistItems";

export type Privacy = "private" | "unlisted" | "public";

/**
 * Per-channel YouTube OAuth credentials. The Studio reads these from the channels
 * table and passes them per request, so one worker publishes to many channels.
 * When none are passed we fall back to the worker's YT_* env (the nibs channel).
 */
export interface YtCreds {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  category_id?: string | null;
}

/** The env-configured (nibs) credentials, or null if the env is not set. */
function envCreds(): YtCreds | null {
  if (
    process.env.YT_CLIENT_ID &&
    process.env.YT_CLIENT_SECRET &&
    process.env.YT_REFRESH_TOKEN
  ) {
    return {
      client_id: process.env.YT_CLIENT_ID,
      client_secret: process.env.YT_CLIENT_SECRET,
      refresh_token: process.env.YT_REFRESH_TOKEN,
      category_id: process.env.YT_CATEGORY_ID ?? null,
    };
  }
  return null;
}

/** Resolve which credentials to use: explicit per-channel creds win, else env. */
function resolveCreds(creds?: YtCreds | null): YtCreds {
  const c = creds ?? envCreds();
  if (!c) throw new Error("YouTube not configured (no per-channel creds and no YT_* env)");
  return c;
}

/** True if we have usable credentials (passed in, or from env). */
export function isConfigured(creds?: YtCreds | null): boolean {
  return Boolean(creds ?? envCreds());
}

/** Exchange the long-lived refresh token for a short-lived access token. */
async function getAccessToken(creds?: YtCreds | null): Promise<string> {
  const c = resolveCreds(creds);
  const body = new URLSearchParams({
    client_id: c.client_id,
    client_secret: c.client_secret,
    refresh_token: c.refresh_token,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`YouTube token refresh ${res.status}: ${t.slice(0, 300)}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("YouTube token refresh returned no access_token");
  return json.access_token;
}

export interface UploadInput {
  buffer: Uint8Array;
  title: string;
  description: string;
  tags: string[];
  privacyStatus?: Privacy; // default "unlisted"
  // Optional scheduled release (ISO-8601 UTC). When set and in the future, the
  // video is forced PRIVATE with a publishAt so YouTube flips it Public itself at
  // that time (this earns the fresh-publish Shorts push a manual flip misses).
  publishAt?: string;
}

/**
 * Resumable upload of a rendered MP4. Returns the new video id.
 * Two round-trips: start a resumable session (metadata), then PUT the bytes.
 */
export async function uploadVideo(input: UploadInput, creds?: YtCreds | null): Promise<string> {
  const c = resolveCreds(creds);
  const accessToken = await getAccessToken(c);
  const categoryId = c.category_id || "28"; // Science & Technology

  // A future publishAt schedules the release. YouTube REQUIRES privacyStatus
  // "private" whenever publishAt is set; it auto-flips to Public at that instant.
  const scheduleAt =
    input.publishAt && Date.parse(input.publishAt) > Date.now() ? input.publishAt : undefined;

  const status: Record<string, unknown> = {
    privacyStatus: scheduleAt ? "private" : input.privacyStatus ?? "unlisted",
    selfDeclaredMadeForKids: false,
    embeddable: true,
  };
  if (scheduleAt) status.publishAt = new Date(scheduleAt).toISOString();

  const metadata = {
    snippet: {
      title: input.title.slice(0, 100),
      description: input.description.slice(0, 4900),
      tags: (input.tags ?? []).slice(0, 15),
      categoryId,
    },
    status,
  };

  // 1) Start resumable session.
  const start = await fetch(UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": "video/mp4",
      "X-Upload-Content-Length": String(input.buffer.byteLength),
    },
    body: JSON.stringify(metadata),
  });
  if (!start.ok) {
    const t = await start.text().catch(() => "");
    throw new Error(`YouTube resumable init ${start.status}: ${t.slice(0, 400)}`);
  }
  const uploadUrl = start.headers.get("location");
  if (!uploadUrl) throw new Error("YouTube resumable init returned no upload URL (Location header)");

  // 2) PUT the bytes in one shot (clips are small — a few MB).
  const put = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "video/mp4",
      "Content-Length": String(input.buffer.byteLength),
    },
    // Node's fetch accepts a Uint8Array/Buffer body at runtime; cast past the
    // stricter DOM BodyInit typing (TS 5.7 ArrayBufferLike vs ArrayBuffer).
    body: input.buffer as unknown as BodyInit,
  });
  if (!put.ok) {
    const t = await put.text().catch(() => "");
    throw new Error(`YouTube upload PUT ${put.status}: ${t.slice(0, 400)}`);
  }
  const json = (await put.json()) as { id?: string };
  if (!json.id) throw new Error("YouTube upload returned no video id");
  return json.id;
}

/**
 * Set a custom thumbnail on a video. Requires the channel to be able to use custom
 * thumbnails (usually phone-verified). Non-fatal for the caller if it fails.
 */
export async function setThumbnail(videoId: string, jpeg: Uint8Array, creds?: YtCreds | null): Promise<void> {
  const accessToken = await getAccessToken(creds);
  const res = await fetch(
    `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "image/jpeg" },
      // Node's fetch accepts a Uint8Array/Buffer body at runtime.
      body: jpeg as unknown as BodyInit,
    },
  );
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`YouTube thumbnails.set ${res.status}: ${t.slice(0, 300)}`);
  }
}

/**
 * Change a video's privacy (used to flip Unlisted -> Public). We first read the
 * current status so the update preserves the other status fields — videos.update
 * resets any field of the "status" part that we omit.
 */
export async function setPrivacy(videoId: string, privacyStatus: Privacy, creds?: YtCreds | null): Promise<void> {
  const accessToken = await getAccessToken(creds);

  // Read current status to avoid clobbering madeForKids / license / embeddable.
  const getRes = await fetch(
    `${VIDEOS_URL}?part=status&id=${encodeURIComponent(videoId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!getRes.ok) {
    const t = await getRes.text().catch(() => "");
    throw new Error(`YouTube videos.list ${getRes.status}: ${t.slice(0, 300)}`);
  }
  const getJson = (await getRes.json()) as {
    items?: Array<{ status?: Record<string, unknown> }>;
  };
  const current = getJson.items?.[0]?.status;
  if (!current) throw new Error(`YouTube: video ${videoId} not found (or not owned by this channel)`);

  const nextStatus = { ...current, privacyStatus };

  const updRes = await fetch(`${VIDEOS_URL}?part=status`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({ id: videoId, status: nextStatus }),
  });
  if (!updRes.ok) {
    const t = await updRes.text().catch(() => "");
    throw new Error(`YouTube videos.update ${updRes.status}: ${t.slice(0, 400)}`);
  }
}

/**
 * Cancel a scheduled release. Reads the current status, DROPS publishAt, and
 * forces privacyStatus "private" so the video will not auto-publish. Used by the
 * Studio "Cancel" button on the scheduled list. Idempotent: a video with no
 * publishAt just stays private.
 */
export async function unschedule(videoId: string, creds?: YtCreds | null): Promise<void> {
  const accessToken = await getAccessToken(creds);

  const getRes = await fetch(
    `${VIDEOS_URL}?part=status&id=${encodeURIComponent(videoId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!getRes.ok) {
    const t = await getRes.text().catch(() => "");
    throw new Error(`YouTube videos.list ${getRes.status}: ${t.slice(0, 300)}`);
  }
  const getJson = (await getRes.json()) as {
    items?: Array<{ status?: Record<string, unknown> }>;
  };
  const current = getJson.items?.[0]?.status;
  if (!current) throw new Error(`YouTube: video ${videoId} not found (or not owned by this channel)`);

  // Rebuild status without publishAt and pinned to private.
  const { publishAt: _drop, ...rest } = current as Record<string, unknown>;
  void _drop;
  const nextStatus = { ...rest, privacyStatus: "private" };

  const updRes = await fetch(`${VIDEOS_URL}?part=status`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({ id: videoId, status: nextStatus }),
  });
  if (!updRes.ok) {
    const t = await updRes.text().catch(() => "");
    throw new Error(`YouTube videos.update ${updRes.status}: ${t.slice(0, 400)}`);
  }
}

export interface VideoStatus {
  id: string;
  privacyStatus: string; // "public" | "private" | "unlisted"
  publishAt: string | null; // ISO scheduled release time, if set
}

/**
 * Read the real status of videos from YouTube (privacy + scheduled publishAt), so the
 * Studio can reconcile its Scheduled list with changes made directly on YouTube.
 * Batches up to 50 ids per call. Videos NOT returned were deleted / are inaccessible —
 * the caller detects a deletion by a requested id being absent from the result.
 */
export async function getVideoStatuses(videoIds: string[], creds?: YtCreds | null): Promise<VideoStatus[]> {
  const ids = videoIds.filter(Boolean);
  if (!ids.length) return [];
  const accessToken = await getAccessToken(creds);
  const out: VideoStatus[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const res = await fetch(
      `${VIDEOS_URL}?part=status&id=${batch.map(encodeURIComponent).join(",")}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`YouTube videos.list ${res.status}: ${t.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      items?: Array<{ id?: string; status?: { privacyStatus?: string; publishAt?: string } }>;
    };
    for (const it of json.items ?? []) {
      if (!it.id) continue;
      out.push({
        id: it.id,
        privacyStatus: it.status?.privacyStatus ?? "unknown",
        publishAt: it.status?.publishAt ?? null,
      });
    }
  }
  return out;
}

export interface ScheduledVideo {
  id: string;
  title: string;
  publishAt: string; // future ISO scheduled release
  privacyStatus: string;
  thumbnail: string | null;
}

/**
 * Enumerate the channel's OWN upcoming scheduled uploads straight from YouTube:
 * private/unlisted videos whose publishAt is in the future. This is the true source
 * of truth for the Studio Scheduled page — it does NOT depend on our local render
 * rows, so it still finds videos whose local records were purged (48h library
 * cleanup) or were never recorded. Scans the most recent `scan` uploads (default 120).
 */
export async function listScheduled(creds?: YtCreds | null, scan = 120): Promise<ScheduledVideo[]> {
  const accessToken = await getAccessToken(creds);

  // 1) Resolve the channel's uploads playlist.
  const chRes = await fetch(`${CHANNELS_URL}?part=contentDetails&mine=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!chRes.ok) {
    const t = await chRes.text().catch(() => "");
    throw new Error(`YouTube channels.list ${chRes.status}: ${t.slice(0, 300)}`);
  }
  const chJson = (await chRes.json()) as {
    items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }>;
  };
  const uploads = chJson.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return [];

  // 2) Page through the most recent uploads to collect video ids.
  const ids: string[] = [];
  let pageToken: string | undefined;
  while (ids.length < scan) {
    const url = new URL(PLAYLIST_ITEMS_URL);
    url.searchParams.set("part", "contentDetails");
    url.searchParams.set("playlistId", uploads);
    url.searchParams.set("maxResults", "50");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const plRes = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!plRes.ok) {
      const t = await plRes.text().catch(() => "");
      throw new Error(`YouTube playlistItems.list ${plRes.status}: ${t.slice(0, 300)}`);
    }
    const plJson = (await plRes.json()) as {
      items?: Array<{ contentDetails?: { videoId?: string } }>;
      nextPageToken?: string;
    };
    for (const it of plJson.items ?? []) {
      const vid = it.contentDetails?.videoId;
      if (vid) ids.push(vid);
    }
    if (!plJson.nextPageToken) break;
    pageToken = plJson.nextPageToken;
  }
  if (!ids.length) return [];

  // 3) Read status+snippet; keep only videos with a FUTURE publishAt.
  const out: ScheduledVideo[] = [];
  const now = Date.now();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const res = await fetch(
      `${VIDEOS_URL}?part=status,snippet&id=${batch.map(encodeURIComponent).join(",")}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`YouTube videos.list ${res.status}: ${t.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      items?: Array<{
        id?: string;
        snippet?: { title?: string; thumbnails?: Record<string, { url?: string }> };
        status?: { privacyStatus?: string; publishAt?: string };
      }>;
    };
    for (const it of json.items ?? []) {
      const publishAt = it.status?.publishAt;
      if (!it.id || !publishAt) continue;
      if (!(Date.parse(publishAt) > now)) continue; // future schedules only
      const th = it.snippet?.thumbnails;
      const thumbnail = th?.medium?.url ?? th?.default?.url ?? th?.high?.url ?? null;
      out.push({
        id: it.id,
        title: it.snippet?.title ?? "",
        publishAt,
        privacyStatus: it.status?.privacyStatus ?? "private",
        thumbnail,
      });
    }
  }
  out.sort((a, b) => Date.parse(a.publishAt) - Date.parse(b.publishAt));
  return out;
}

/** Parse a YouTube video id from a full URL or return the raw id if already one. */
export function parseVideoId(input: string): string | null {
  const s = (input || "").trim();
  if (!s) return null;
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1, 12) || null;
    const v = u.searchParams.get("v");
    if (v) return v;
    const m = u.pathname.match(/\/(shorts|embed|live)\/([a-zA-Z0-9_-]{11})/);
    if (m) return m[2];
  } catch {
    /* not a URL */
  }
  return null;
}
