/**
 * Uploads for the render worker.
 *
 * PRIMARY path (recommended): the Studio's render edge function passes short-lived
 * signed upload URLs in the render spec. The worker PUTs straight to them and needs
 * NO Supabase URL or keys — the service_role key never leaves Lovable's backend.
 *
 * FALLBACK path (optional): if you set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY on the
 * worker, it can upload directly. Only use this if you actually hold a service_role key.
 */

/** PUT a buffer to a Supabase signed upload URL. No client/keys required. */
export async function putToSignedUrl(
  signedUrl: string,
  data: Buffer,
  contentType: string
): Promise<void> {
  const res = await fetch(signedUrl, {
    method: "PUT",
    headers: { "content-type": contentType, "x-upsert": "true" },
    // undici accepts a Buffer at runtime; cast past the stricter DOM BodyInit typing.
    body: data as unknown as BodyInit,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`signed upload failed (${res.status}): ${body}`);
  }
}

/** Optional direct upload using a service_role key (only if env is set). */
export async function uploadWithServiceRole(
  objectPath: string,
  data: Buffer,
  contentType: string
): Promise<string> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.SUPABASE_BUCKET || "renders";
  if (!url || !key) {
    throw new Error(
      "No signed upload URLs in the render spec and no SUPABASE_URL/SERVICE_ROLE_KEY set — cannot upload."
    );
  }
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const { error } = await supabase.storage
    .from(bucket)
    .upload(objectPath, data, { contentType, upsert: true });
  if (error) throw new Error(`Supabase upload failed (${objectPath}): ${error.message}`);
  return `${bucket}/${objectPath}`;
}
