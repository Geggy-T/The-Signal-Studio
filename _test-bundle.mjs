import { bundle } from "@remotion/bundler";
import path from "node:path";
try {
  const url = await bundle({ entryPoint: path.join(process.cwd(), "src/remotion/index.ts") });
  console.log("BUNDLE_OK");
} catch (e) {
  console.error("BUNDLE_FAIL:", (e && e.message ? e.message : String(e)).slice(0, 600));
  process.exit(2);
}
