/**
 * Guarantees a working Electron binary after `pnpm install`.
 *
 * WHY THIS EXISTS
 * Electron 42.x ships no `postinstall` script at all, so `pnpm install` alone never
 * fetches the ~350 MB runtime — you get the JS wrapper and nothing to run it with.
 * Running Electron's own `install.js` by hand does not save you either: on Windows it
 * extracts one file out of seventy-five and then exits 0, so the failure is completely
 * silent. `pnpm start` afterwards fails with a missing-binary error that points nowhere
 * near the real cause, and a fresh clone looks broken for no visible reason.
 *
 * So this script does the job itself: verify, fetch (cache first), extract, verify
 * again, and fail LOUDLY with an actionable message if any step falls short. It is
 * wired into the root `postinstall`, so cloning and running `pnpm install` is enough.
 *
 * Safe to run repeatedly — it exits immediately when the binary is already good.
 * Force a reinstall with:  node scripts/ensure-electron.mjs --force
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const force = process.argv.includes("--force");

/** Electron only ever runs on Windows here, and the extract path below is Windows-only. */
if (process.platform !== "win32") {
  console.log("[electron] not win32 — skipping (this app targets Windows).");
  process.exit(0);
}

/** Resolve the real electron package directory through the pnpm symlink farm. */
function findElectronDir() {
  const require = createRequire(path.join(repoRoot, "apps", "desktop", "package.json"));
  try {
    // Resolves to <pkg>/index.js; its directory is the package root.
    return path.dirname(require.resolve("electron"));
  } catch {
    return null;
  }
}

const electronDir = findElectronDir();
if (!electronDir) {
  console.error("[electron] cannot locate the electron package. Run `pnpm install` first.");
  process.exit(1);
}

const { version } = JSON.parse(fs.readFileSync(path.join(electronDir, "package.json"), "utf8"));
const distDir = path.join(electronDir, "dist");
const exeName = "electron.exe";
const exePath = path.join(distDir, exeName);
const pathTxt = path.join(electronDir, "path.txt");
const arch = process.env.npm_config_arch || process.arch;
const artifact = `electron-v${version}-win32-${arch}.zip`;

/**
 * A real install is more than the .exe existing: the silent-failure mode leaves a dist
 * folder holding a single file, which would otherwise read as "already installed".
 */
function isHealthy() {
  if (!fs.existsSync(exePath) || !fs.existsSync(pathTxt)) return false;
  if (fs.readFileSync(pathTxt, "utf8").trim() !== exeName) return false;
  // A good extraction leaves ~21 entries at the top level; the broken one left exactly 1.
  return fs.readdirSync(distDir).length >= 10;
}

if (!force && isHealthy()) {
  process.exit(0);
}

/** Electron's download cache, shared across every project on the machine. */
function findCachedZip() {
  const cacheRoot =
    process.env.electron_config_cache ||
    path.join(os.homedir(), "AppData", "Local", "electron", "Cache");
  if (!fs.existsSync(cacheRoot)) return null;
  // Cache layout is <root>/<sha-ish dir>/<artifact>, so one level down is enough.
  for (const entry of fs.readdirSync(cacheRoot)) {
    const candidate = path.join(cacheRoot, entry, artifact);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** SHA-256 from electron's bundled checksums.json, so a download is never trusted blindly. */
function expectedSha() {
  try {
    const sums = JSON.parse(fs.readFileSync(path.join(electronDir, "checksums.json"), "utf8"));
    return typeof sums[artifact] === "string" ? sums[artifact].toLowerCase() : null;
  } catch {
    return null;
  }
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function download(dest) {
  const mirror =
    process.env.ELECTRON_MIRROR || "https://github.com/electron/electron/releases/download/";
  const url = `${mirror}v${version}/${artifact}`;
  console.log(`[electron] downloading ${artifact} (~120 MB)...`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`download failed: HTTP ${res.status} from ${url}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

/**
 * .NET's ZipFile rather than the `extract-zip` dependency electron uses — extract-zip is
 * exactly what stops one file in and reports success, and this path is proven on this
 * toolchain. execFileSync throws on a non-zero exit, so a failure here cannot pass silently.
 */
function extract(zipPath) {
  fs.rmSync(distDir, { recursive: true, force: true });
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
        `[System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath.replace(/'/g, "''")}', '${distDir.replace(/'/g, "''")}')`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
}

async function main() {
  let zipPath = findCachedZip();

  if (zipPath) {
    console.log(`[electron] using cached ${artifact}`);
  } else {
    zipPath = path.join(os.tmpdir(), "aced-electron", artifact);
    await download(zipPath);
  }

  const want = expectedSha();
  if (want) {
    const got = sha256(zipPath);
    if (got !== want) {
      throw new Error(
        `checksum mismatch for ${artifact}\n  expected ${want}\n  got      ${got}\n` +
          `Delete the cached file and retry.`,
      );
    }
  }

  console.log("[electron] extracting...");
  extract(zipPath);
  fs.writeFileSync(pathTxt, exeName);

  if (!isHealthy()) {
    const count = fs.existsSync(distDir) ? fs.readdirSync(distDir).length : 0;
    throw new Error(`extraction produced ${count} entries and no usable ${exeName}.`);
  }

  console.log(`[electron] ready — ${fs.readdirSync(distDir).length} files in dist/`);
}

main().catch((err) => {
  console.error(`\n[electron] SETUP FAILED\n  ${err.message}\n`);
  console.error("  Retry with:  pnpm run repair:electron");
  process.exit(1);
});
