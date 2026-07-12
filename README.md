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

## Deploy to Railway (from GitHub)

1. Push this folder to your GitHub repo.
2. In Railway: **New Project → Deploy from GitHub repo** → pick the repo. Railway detects the `Dockerfile`.
3. Add service **Variables** (from `.env.example`):
   - `RENDER_WORKER_SECRET` — a long random string (must match the same secret in Supabase).
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY` — from Supabase → Project Settings → API (service_role, keep secret).
   - `SUPABASE_BUCKET` — `renders` (create this Storage bucket in Supabase first).
4. Deploy. Railway gives you a public URL — that's your `RENDER_WORKER_URL`.
5. In the **Studio (Supabase) secrets**, set `RENDER_WORKER_URL` to that URL and `RENDER_WORKER_SECRET` to the same string.

First deploy builds Chrome Headless Shell into the image, so it's a few minutes; renders after that are fast.

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
