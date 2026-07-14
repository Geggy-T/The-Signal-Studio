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

export type Privacy = "private" | "unlisted" | "public";

export function isConfigured(): boolean {
  return Boolean(
    process.env.YT_CLIENT_ID && process.env.YT_CLIENT_SECRET && process.env.YT_REFRESH_TOKEN,
  );
}

/** Exchange the long-lived refresh token for a short-lived access token. */
async function getAccessToken(): Promise<string> {
  const body = new URLSearchParams({
    client_id: process.env.YT_CLIENT_ID ?? "",
    client_secret: process.env.YT_CLIENT_SECRET ?? "",
    refresh_token: process.env.YT_REFRESH_TOKEN ?? "",
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
export async function uploadVideo(input: UploadInput): Promise<string> {
  const accessToken = await getAccessToken();
  const categoryId = process.env.YT_CATEGORY_ID || "28"; // Science & Technology

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
export async function setThumbnail(videoId: string, jpeg: Uint8Array): Promise<void> {
  const accessToken = await getAccessToken();
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
export async function setPrivacy(videoId: string, privacyStatus: Privacy): Promise<void> {
  const accessToken = await getAccessToken();

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
