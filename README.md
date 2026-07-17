# Signal — Render Worker

The self-hosted render muscle for **The Signal — Studio**. A small Node + [Remotion](https://remotion.dev) HTTP service that composes a 9:16 commentary clip and uploads the MP4 + thumbnail to Supabase Storage. Runs on **Railway** — no subscription, you pay only the compute you already have.

It renders the Phase-0 composition: **cold-open thesis card → source clip (cover-cropped to vertical, word-by-word captions, Josh interjections ducking the source audio) → takeaway card with the "Noise off." sign-off**, all in the near-black + amber brand.

---

## API

### `POST /render`
Header: `Authorization: Bearer <RENDER_WORKER_SECRET>`

Body (see `src/types.ts` for the full schema):
```json
{
  "clip_candidate_id": "uuid",
  "source_url": "https://.../source.mp4",
  "t_in": 812.4,
  "t_out": 848.9,
  "captions": [{ "text": "the", "start": 812.5, "end": 812.7 }],
  "audio": {
    "hook_url": "https://.../hook.mp3",
    "takeaway_url": "https://.../takeaway.mp3",
    "interjections": [{ "at": 12.0, "url": "https://.../int1.mp3", "duration_s": 3 }]
  },
  "title": "The one line that matters",
  "hook_text": "Everyone missed the real signal here.",
  "takeaway_text": "Noise off.",
  "brand": { "bg": "#0f1113", "accent": "#F5A623", "channel_name": "The Signal" },
  "callback_url": "https://<project>.supabase.co/functions/v1/render-callback"
}
```

- **With `callback_url`** → returns `202 { status: "accepted" }`, then POSTs the result to the callback when done (recommended — renders can take a minute).
- **Without `callback_url`** → renders synchronously and returns the result inline.

Result:
```json
{ "status": "done", "clip_candidate_id": "uuid",
  "output_path": "renders/clips/uuid.mp4",
  "thumbnail_path": "renders/clips/uuid.jpeg",
  "duration_s": 41.2, "bytes": 5123456 }
```

### `GET /health` → `{ ok: true }`

---

## Uploads: signed URLs (no Supabase keys on the worker)

The worker does **not** hold Supabase credentials. For each job, the Studio's `render`
edge function (which has internal Supabase access via Lovable) creates short-lived
**signed upload URLs** with `storage.createSignedUploadUrl(path)` and includes them in
the render spec (`upload.mp4_put_url`, `upload.thumb_put_url`, `upload.mp4_path`,
`upload.thumb_path`). The worker simply `PUT`s the finished MP4 + thumbnail to those URLs
and returns the storage paths. The `service_role` key never leaves Lovable's backend.

*(Optional fallback: if you ever do hold a service_role key, set `SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE_KEY` and the worker will upload directly instead.)*

## Deploy to Railway (from GitHub)

1. Push this folder to your GitHub repo.
2. In Railway: **New Project → Deploy from GitHub repo** → pick the repo. Railway detects the `Dockerfile`.
3. Add **one** service variable:
   - `RENDER_WORKER_SECRET` — a long random string (must match the same secret in the Studio's Supabase secrets).
   - *(That's it. No Supabase URL or keys needed — see "Uploads" above.)*
4. Deploy. Railway gives you a public URL — that's your `RENDER_WORKER_URL`.
5. In the **Studio (Supabase) secrets**, set `RENDER_WORKER_URL` to that URL and `RENDER_WORKER_SECRET` to the same string.

The Chrome Headless Shell downloads automatically on the **first render** (~30–60s once), then renders are fast. Give the Railway service **2 GB+ memory** for comfortable rendering.

---

## Local dev

```bash
cp .env.example .env      # fill in values
npm install
npm run dev               # worker on http://localhost:8080
# preview the composition visually:
npm run studio
```

Test:
```bash
curl -X POST http://localhost:8080/render \
  -H "Authorization: Bearer $RENDER_WORKER_SECRET" \
  -H "content-type: application/json" \
  -d @sample-render-spec.json
```

---

## Notes / tunables (Phase 0)

- Cold-open is fixed at **4s** and takeaway at **5s** (`HOOK_SECONDS` / `TAKEAWAY_SECONDS` in `src/types.ts`). If Josh's hook audio runs longer, bump these or probe audio length later.
- Source is **cover-cropped** center to vertical — Phase-2 adds face/subject-tracking reframe.
- Captions render a 7-word window with the active word in amber; timings come straight from the Groq Whisper transcript.
- One composition/template for now; the variation engine (multiple templates) lands in Phase 2.
- Fonts: the brand look expects **Space Grotesk** — bundle it via `@remotion/google-fonts` if you want it embedded (falls back to system sans otherwise).

## Multi-channel (final62-multicore)

The worker is now channel-agnostic and fully backward compatible:

- **Per-channel logo:** `spec.brand.logo_url` (optional, public URL) is rendered
  top-left every frame. When absent it falls back to the bundled `public/logo.png`
  (nibs' coral "i" mark), so nothing changes for nibs.
- **Per-channel YouTube creds:** `spec.publish.credentials`
  `{ client_id, client_secret, refresh_token, category_id? }` (optional) publishes to
  THAT channel. When absent the worker falls back to its `YT_*` env (the nibs channel).
  The same optional `credentials` object is accepted on the `/youtube/publish`,
  `/youtube/unschedule`, and `/youtube/status` endpoints.

The Studio reads these from the `channels` table and passes them per render job
(wired in Phase 5). `YT_*` env stays set for nibs as the default fallback.
