import electron from "electron";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";

/**
 * The user's API keys, entered once in the overlay's Keys panel and kept on this PC only.
 *
 * Stored under userData, encrypted with Windows' own per-user protection (Electron
 * safeStorage / DPAPI), and loaded into process.env at startup — the same place a .env
 * file puts them — so every provider reads keys exactly as before. Keys never reach the
 * renderer: it only ever sees whether each one is set and its last four characters.
 */
const { app, safeStorage } = electron;

/** The keys the panel manages: answers, speech-to-text, and the optional Gujarati STT. */
export const MANAGED_KEYS = ["GROQ_API_KEY", "DEEPGRAM_API_KEY", "SARVAM_API_KEY"] as const;
export type ManagedKey = (typeof MANAGED_KEYS)[number];

interface StoredKeys {
  /** True when values are safeStorage ciphertext (base64); false = plain fallback. */
  encrypted: boolean;
  keys: Partial<Record<ManagedKey, string>>;
}

function storePath(): string {
  return path.join(app.getPath("userData"), "keys.json");
}

function readStore(): StoredKeys {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), "utf8")) as Partial<StoredKeys>;
    return {
      encrypted: parsed.encrypted === true,
      keys: typeof parsed.keys === "object" && parsed.keys !== null ? parsed.keys : {},
    };
  } catch {
    return { encrypted: false, keys: {} };
  }
}

/** Decrypts every stored key; an unreadable entry is skipped rather than failing startup. */
function decryptAll(store: StoredKeys, log: (message: string) => void): Partial<Record<ManagedKey, string>> {
  const out: Partial<Record<ManagedKey, string>> = {};
  for (const name of MANAGED_KEYS) {
    const stored = store.keys[name];
    if (!stored) continue;
    try {
      out[name] = store.encrypted
        ? safeStorage.decryptString(Buffer.from(stored, "base64"))
        : stored;
    } catch (err) {
      log(`KEYS could not read saved ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

/**
 * Loads saved keys into process.env. Saved keys win over a .env file: the panel is what
 * the user last chose. Must run after app 'ready' (safeStorage needs it on Windows).
 */
export function loadSavedKeys(log: (message: string) => void): void {
  const keys = decryptAll(readStore(), log);
  for (const [name, value] of Object.entries(keys)) {
    if (value?.trim()) process.env[name] = value.trim();
  }
  const loaded = Object.keys(keys).length;
  if (loaded > 0) log(`KEYS loaded ${String(loaded)} saved key(s)`);
}

/** Merges `updates` into the store, writes it atomically, and applies them to process.env. */
export function saveKeys(updates: Partial<Record<ManagedKey, string>>, log: (message: string) => void): void {
  const current = decryptAll(readStore(), log);
  const merged = { ...current, ...updates };
  const encrypted = safeStorage.isEncryptionAvailable();
  const store: StoredKeys = { encrypted, keys: {} };
  for (const name of MANAGED_KEYS) {
    const value = merged[name]?.trim();
    if (!value) continue;
    store.keys[name] = encrypted ? safeStorage.encryptString(value).toString("base64") : value;
  }
  // Write-then-rename, so a crash mid-write can never leave a half-written key file.
  const target = storePath();
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(store));
  fs.renameSync(temp, target);
  for (const [name, value] of Object.entries(updates)) {
    if (value?.trim()) process.env[name] = value.trim();
  }
  log(`KEYS saved (${Object.keys(updates).join(", ")}; encrypted=${String(encrypted)})`);
}

/** What the renderer may see about one key: whether it is set, and its last 4 characters. */
export interface KeyState {
  set: boolean;
  hint: string;
}

export function keyStates(): Record<ManagedKey, KeyState> {
  const state = {} as Record<ManagedKey, KeyState>;
  for (const name of MANAGED_KEYS) {
    const value = process.env[name]?.trim() ?? "";
    state[name] = { set: value.length > 0, hint: value.length >= 8 ? `…${value.slice(-4)}` : "" };
  }
  return state;
}

/**
 * Cleans a pasted key: trims whitespace and quotes, and drops a "NAME=" prefix in case a
 * whole .env line was pasted. Keys never contain spaces, so any inner whitespace (a
 * line break picked up by the copy) is removed too.
 */
export function cleanKey(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let value = raw.trim().replace(/^[A-Z_]+\s*=\s*/, "");
  value = value.replace(/^["'`]+|["'`]+$/g, "");
  return value.replace(/\s+/g, "");
}

/** Outcome of checking one key against its provider. */
export interface KeyCheck {
  /** "valid" = the provider accepted it; "invalid" = it was rejected; "unverified" = no answer. */
  verdict: "valid" | "invalid" | "unverified";
  message: string;
}

const CHECK_TIMEOUT_MS = 9_000;

/**
 * Asks the provider whether a key works, using the same endpoint the app itself relies on,
 * so "valid" here means the real feature will work. A network failure is "unverified"
 * rather than "invalid": a flaky connection must not block saving a correct key.
 */
export async function checkKey(name: ManagedKey, key: string): Promise<KeyCheck> {
  try {
    if (name === "GROQ_API_KEY") {
      const res = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      return verdictFor(res.status, "Groq");
    }
    if (name === "DEEPGRAM_API_KEY") {
      // The short-lived-token endpoint the app calls on every Start.
      const res = await fetch("https://api.deepgram.com/v1/auth/grant", {
        method: "POST",
        headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl_seconds: 30 }),
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      if (res.status === 403) {
        return {
          verdict: "invalid",
          message: "Deepgram accepted the key but it lacks permission. Create a key with the Member role.",
        };
      }
      return verdictFor(res.status, "Deepgram");
    }
    return await checkSarvamKey(key);
  } catch (err) {
    return {
      verdict: "unverified",
      message: `Saved, but could not reach the provider to check it (${err instanceof Error ? err.message : String(err)}).`,
    };
  }
}

function verdictFor(status: number, label: string): KeyCheck {
  if (status >= 200 && status < 300) return { verdict: "valid", message: `${label} key works.` };
  if (status === 401 || status === 403) {
    return { verdict: "invalid", message: `${label} rejected this key. Copy it again and paste it here.` };
  }
  return { verdict: "unverified", message: `Saved, but ${label} answered HTTP ${String(status)} when checked.` };
}

/** Sarvam has no key-check endpoint, so open (and immediately close) the streaming socket. */
function checkSarvamKey(key: string): Promise<KeyCheck> {
  return new Promise((resolve) => {
    const url =
      "wss://api.sarvam.ai/speech-to-text-translate/ws?model=saaras:v3&mode=transcribe&sample_rate=16000";
    const socket = new WebSocket(url, { headers: { "Api-Subscription-Key": key } });
    let settled = false;
    const finish = (result: KeyCheck): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.terminate();
      } catch {
        // Already closed.
      }
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ verdict: "unverified", message: "Saved, but Sarvam did not answer the check in time." }),
      CHECK_TIMEOUT_MS,
    );
    socket.on("open", () => finish({ verdict: "valid", message: "Sarvam key works." }));
    socket.on("unexpected-response", (_req, res) => finish(verdictFor(res.statusCode ?? 0, "Sarvam")));
    socket.on("error", (err) =>
      finish({ verdict: "unverified", message: `Saved, but the Sarvam check failed (${err.message}).` }),
    );
  });
}
