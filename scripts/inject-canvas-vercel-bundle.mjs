/**
 * Inject the host-architecture Linux canvas binding into the already-built
 * settlement upload Vercel function. `vercel deploy --prebuilt` uploads only
 * filePathMap entries, so restoring node_modules after `vercel build` alone is
 * insufficient.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { CONFIG_RELATIVE_PATH, linuxBindingEntry } from "./verify-canvas-vercel-bundle.mjs";

export function injectCanvasBinding(root) {
  const configPath = path.join(root, CONFIG_RELATIVE_PATH);
  if (!fs.existsSync(configPath)) throw new Error("prebuilt settlement upload config is unavailable");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const architecture = config?.architecture;
  if (architecture !== "arm64" && architecture !== "x64") throw new Error("unsupported function architecture");
  const relative = linuxBindingEntry(architecture);
  const source = path.join(root, relative);
  if (!fs.existsSync(source)) throw new Error("Linux canvas binding is unavailable after build");
  config.filePathMap ??= {};
  config.filePathMap[relative] = relative;
  fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  if (fs.statSync(source).size < 1) throw new Error("canvas binding injection failed");
  console.log(`[inject-canvas-vercel-bundle] injected ${relative}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  injectCanvasBinding(path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."));
}
