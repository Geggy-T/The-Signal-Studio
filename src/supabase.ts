import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BUCKET = process.env.SUPABASE_BUCKET || "renders";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("[supabase] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — uploads will fail.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/**
 * Uploads a buffer to the `renders` bucket and returns the storage path.
 * The Studio app resolves this to a signed/public URL when displaying.
 */
export async function uploadToStorage(
  objectPath: string,
  data: Buffer,
  contentType: string
): Promise<string> {
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(objectPath, data, { contentType, upsert: true });
  if (error) throw new Error(`Supabase upload failed (${objectPath}): ${error.message}`);
  return `${BUCKET}/${objectPath}`;
}
