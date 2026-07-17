import path from "node:path";
import os from "node:os";
import fs from "node:fs";

/** Local dir the worker serves over HTTP so headless Chrome can read pre-cut clips fast. */
export const SERVE_DIR = path.join(os.tmpdir(), "signal-serve");
try {
  fs.mkdirSync(SERVE_DIR, { recursive: true });
} catch {
  /* ignore */
}
