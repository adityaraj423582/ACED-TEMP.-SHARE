// Copies the renderer's static assets (HTML/CSS) into dist/ next to the compiled
// renderer.js. tsc only emits the TypeScript; these files must travel with it.
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src", "renderer");
const outDir = join(here, "..", "dist", "renderer");

mkdirSync(outDir, { recursive: true });
for (const file of ["index.html", "styles.css"]) {
  cpSync(join(srcDir, file), join(outDir, file));
}
