# ── Auth between Supabase and this worker (THE ONLY REQUIRED VAR) ──
# Must match RENDER_WORKER_SECRET stored in your Supabase project secrets.
RENDER_WORKER_SECRET=change-me-to-a-long-random-string

# ── Server ──
PORT=8080

# ── OPTIONAL fallback only ──────────────────────────────────────────────
# Leave these UNSET for the normal setup. The Studio's render edge function
# sends short-lived signed upload URLs in each render request, so the worker
# uploads without any Supabase keys. Only set these if you actually hold a
# service_role key and want the worker to upload directly instead.
# SUPABASE_URL=https://YOUR-PROJECT.supabase.co
# SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
# SUPABASE_BUCKET=renders

# ── YouTube auto-upload + publish (Tech on Toast @techontoast) ──────────────
# Needed for auto-uploading finished clips (Unlisted) and the "Make Public"
# button. If UNSET, uploads are skipped and the pipeline still completes.
# Scopes on the refresh token: youtube.upload + youtube.force-ssl.
# YT_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
# YT_CLIENT_SECRET=your-oauth-client-secret
# YT_REFRESH_TOKEN=your-refresh-token-for-@techontoast
# YT_CATEGORY_ID=28   # 28 = Science & Technology (default)
