import electron from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_NAME,
  type InferContextLine,
  type InterviewRole,
  parseInterviewRole,
  parseSttProvider,
  STT_PROVIDERS,
  type SttProvider,
  type TurnCompleteResponse,
} from "@aced/shared";
import {
  classifyTurnComplete,
  InferError,
  setDiagnosticSink,
  streamAnswer,
  streamCodingAnswer,
  streamExplain,
  streamPseudocode,
} from "./providers/groq.js";
import {
  checkKey,
  cleanKey,
  keyStates,
  loadSavedKeys,
  type ManagedKey,
  saveKeys,
} from "./providers/keys.js";
import { SARVAM_RELAY_PATH, startSarvamRelay, stopSarvamRelay } from "./providers/sarvam-relay.js";
import { mintDeepgramToken, mintElevenLabsToken } from "./providers/stt-tokens.js";
import {
  type AnswerProviderChoice,
  type AppConfig,
  type BackdropColor,
  IpcChannel,
  type KeyField,
  type KeyFieldResult,
  type KeysSaveResult,
  type KeysStatus,
  parseAnswerProvider,
  type InferRunResult,
  type NotesOpenResult,
  type NotesQuestion,
  type SarvamRelayResult,
  type StatusEntry,
  type SttTokenResult,
} from "./ipc.js";

const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  screen,
  session,
  desktopCapturer,
  webContents,
  shell,
} = electron;

app.setName(APP_NAME);

/*
 * The app is launched detached and the launching terminal is then closed:
 *   Start-Process pnpm -ArgumentList "start" -WindowStyle Hidden
 * Once that terminal exits, stdout/stderr point at a pipe with no reader. The next
 * write raises EPIPE, and an unhandled stream error would take the whole app down
 * mid-meeting — a crash with no window and no message. Swallow those; the real log
 * is the diagnostics file, which does not depend on a console existing.
 */
process.stdout.on("error", () => undefined);
process.stderr.on("error", () => undefined);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load the repo-root .env so the provider API keys (GROQ_API_KEY, DEEPGRAM_API_KEY,
// ELEVENLABS_API_KEY, MISTRAL_API_KEY, GEMINI_API_KEY) are available. No-op if the
// file is absent (e.g. a packaged build where the keys come from the environment).
try {
  process.loadEnvFile(path.resolve(__dirname, "..", "..", "..", ".env"));
} catch {
  // Fall back to the ambient environment.
}

/**
 * Repairs a UTF-8 BOM on the first line of .env.
 *
 * Editors that save "UTF-8 with BOM" (Notepad, and PowerShell's `Set-Content
 * -Encoding utf8` on Windows PowerShell 5.1) put three invisible bytes at the start
 * of the file. loadEnvFile folds them into the FIRST variable's name, so that one
 * key — and only that one — silently disappears while every other key works. The
 * failure looks like a provider outage rather than a file problem, so repair it
 * here instead of leaving it to be rediscovered mid-interview.
 */
function repairBomEnvKeys(): void {
  const BOM = "﻿";
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(BOM)) continue;
    const clean = key.slice(BOM.length);
    if (!process.env[clean] && value !== undefined) process.env[clean] = value;
    delete process.env[key];
    diag(`ENV repaired BOM-prefixed key: ${clean}`);
  }
}
repairBomEnvKeys();

/** The single overlay window. Kept at module scope so lifecycle handlers can reach it. */
let overlay: Electron.BrowserWindow | null = null;

/** Coalesces the "window moved" notification while a native drag is in progress. */
let movedNotifyTimer: NodeJS.Timeout | null = null;

/** The "ask" hotkey. Tells the overlay to fire inference on its current context. */
const ASK_HOTKEY = "CommandOrControl+Enter";

/** Show/hide the overlay without quitting (handy mid-meeting). */
const TOGGLE_HOTKEY = "CommandOrControl+Shift+H";

/** Coding mode: screenshot the screen and stream a solution to the on-screen question. */
const CODING_HOTKEY = "CommandOrControl+Shift+C";

/** Lock/unlock the answer box so nothing overwrites it (handy while typing live code). */
const LOCK_HOTKEY = "CommandOrControl+Shift+L";

/** Cycle the overlay's contrast (normal -> dim -> ultra) so a neighbour can't read it. */
const DIM_HOTKEY = "CommandOrControl+Shift+D";

/**
 * Kill switch — "control + die". Tears the whole app down instantly: no graceful
 * shutdown, no confirmation. Uses app.exit() rather than app.quit() so it skips the
 * will-quit handlers entirely; the OS reclaims the sockets, streams and relay port.
 */
const KILL_HOTKEY = "CommandOrControl+D";

/** Make the dimmed overlay fainter / clearer on the fly, so it can be tuned live. */
const DIM_FAINTER_HOTKEY = "CommandOrControl+Shift+Up";
const DIM_CLEARER_HOTKEY = "CommandOrControl+Shift+Down";

/** Grow / shrink the window height, so a long answer can be given more room fast. */
const TALLER_HOTKEY = "CommandOrControl+Shift+=";
const SHORTER_HOTKEY = "CommandOrControl+Shift+-";

/** Height step per press, and the floor/ceiling for the resize hotkeys. */
const HEIGHT_STEP = 60;
const MIN_WINDOW_HEIGHT = 120;

/**
 * Grows or shrinks the overlay by one step, keeping its top-left corner fixed. The
 * compact bar is frameless, so its drag-to-resize edge is only a few pixels — this
 * gives a reliable way to make room for a long answer mid-call. The new size is
 * remembered as the compact size when dimmed (see the resize handler).
 */
function nudgeWindowHeight(step: number): void {
  if (!overlay || overlay.isDestroyed()) return;
  const bounds = overlay.getBounds();
  const maxHeight = screen.getDisplayMatching(bounds).workArea.height;
  const height = Math.min(Math.max(bounds.height + step, MIN_WINDOW_HEIGHT), maxHeight);
  if (height === bounds.height) return;
  overlay.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height });
}

/** Turn the last coding solution into pseudo code (when the interviewer asks for it). */
const PSEUDOCODE_HOTKEY = "CommandOrControl+Shift+P";

/** Explain the on-screen code's logic (for "walk me through your code"). */
const EXPLAIN_HOTKEY = "CommandOrControl+Shift+E";

/**
 * Cap the captured screenshot's longest side. This is the dominant cost of a vision
 * call: at 1600px a single screenshot consumed ~7.5k tokens against Groq's free-tier
 * 8k tokens/minute limit, so a second Code press inside a minute got a 429. 1100px
 * roughly halves that (area scales with the square) while keeping editor text legible.
 */
const MAX_CAPTURE_EDGE = 1100;

/** Persisted settings (STT provider + interview role) under the app's userData dir. */
interface PersistedSettings {
  sttProvider?: SttProvider;
  /** The role the user is interviewing for; tailors answer emphasis. */
  role?: InterviewRole;
  /** Chosen dim faintness (text-to-backdrop gap); smaller = fainter. */
  dimDelta?: number;
  /** Which AI writes the answers ("auto" = the tuned order). */
  answerProvider?: AnswerProviderChoice;
}

/** Faintness used when nothing has been saved yet. */
const DEFAULT_DIM_DELTA = 5;

function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

/**
 * Settings live in memory and are flushed to disk on a short delay.
 *
 * Dim faintness is bound to Ctrl+Shift+Up/Down, so holding the key used to fire a
 * synchronous read AND a synchronous write per repeat — dozens of blocking disk round
 * trips on the main process while the user is just tuning the overlay, which is the one
 * moment they can see stutter. Reads now hit the cache, and writes coalesce.
 */
let settingsCache: PersistedSettings | null = null;
let settingsFlush: NodeJS.Timeout | null = null;

/** Long enough to swallow a key-repeat burst, short enough to survive a normal quit. */
const SETTINGS_FLUSH_MS = 400;

function readSettings(): PersistedSettings {
  if (settingsCache) return settingsCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), "utf8")) as PersistedSettings;
    settingsCache = typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    settingsCache = {};
  }
  return settingsCache;
}

/** Writes the pending settings immediately. Safe to call when nothing is pending. */
function flushSettings(): void {
  if (settingsFlush) {
    clearTimeout(settingsFlush);
    settingsFlush = null;
  }
  if (!settingsCache) return;
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(settingsCache));
  } catch (err) {
    diag(`SETTINGS save failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function writeSettings(settings: PersistedSettings): void {
  // Update the cache first so a subsequent read sees the new value even before the flush.
  settingsCache = settings;
  if (settingsFlush) clearTimeout(settingsFlush);
  settingsFlush = setTimeout(flushSettings, SETTINGS_FLUSH_MS);
}

/** The active STT provider: persisted setting > STT_PROVIDER env > default. */
let activeSttProvider: SttProvider = "deepgram";

function resolveInitialProvider(): SttProvider {
  const saved = readSettings().sttProvider;
  if (saved && (STT_PROVIDERS as readonly string[]).includes(saved)) {
    return saved;
  }
  return parseSttProvider(process.env.STT_PROVIDER);
}

function hasKey(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

function buildAppConfig(): AppConfig {
  return {
    sttProvider: activeSttProvider,
    availableProviders: {
      deepgram: hasKey("DEEPGRAM_API_KEY"),
      elevenlabs: hasKey("ELEVENLABS_API_KEY"),
      sarvam: hasKey("SARVAM_API_KEY"),
    },
    groqReady: hasKey("GROQ_API_KEY"),
    turnDebug: process.env.TURN_DEBUG === "true",
    dimDelta: readSettings().dimDelta ?? DEFAULT_DIM_DELTA,
    answerProvider: parseAnswerProvider(readSettings().answerProvider),
    availableAnswerProviders: {
      auto: true,
      groq: hasKey("GROQ_API_KEY"),
      mistral: hasKey("MISTRAL_API_KEY"),
      gemini: hasKey("GEMINI_API_KEY"),
    },
  };
}

/** Keys panel field -> the environment variable every provider reads. */
const KEY_FIELD_ENV: Record<KeyField, ManagedKey> = {
  groq: "GROQ_API_KEY",
  deepgram: "DEEPGRAM_API_KEY",
  sarvam: "SARVAM_API_KEY",
};

function keysStatus(): KeysStatus {
  const states = keyStates();
  return {
    groq: states.GROQ_API_KEY,
    deepgram: states.DEEPGRAM_API_KEY,
    sarvam: states.SARVAM_API_KEY,
  };
}

/**
 * Checks every key entered in the Keys panel with its provider (in parallel), saves the
 * ones that work, and reports each outcome. A key the provider REJECTS is not saved, so
 * a bad paste can never replace a key that was working.
 */
async function saveKeyEntries(raw: unknown): Promise<KeysSaveResult> {
  const input = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const results: Partial<Record<KeyField, KeyFieldResult>> = {};
  const accepted: Partial<Record<ManagedKey, string>> = {};
  const fields = Object.keys(KEY_FIELD_ENV) as KeyField[];

  await Promise.all(
    fields.map(async (field) => {
      const value = cleanKey(input[field]);
      if (!value) return;
      const check = await checkKey(KEY_FIELD_ENV[field], value);
      results[field] = check;
      if (check.verdict !== "invalid") accepted[KEY_FIELD_ENV[field]] = value;
      diag(`KEYS check ${field}: ${check.verdict}`);
    }),
  );

  if (Object.keys(accepted).length > 0) {
    try {
      saveKeys(accepted, diag);
    } catch (err) {
      const message = `Could not save keys: ${err instanceof Error ? err.message : String(err)}`;
      diag(message);
      for (const field of fields) {
        if (results[field] && results[field].verdict !== "invalid") {
          results[field] = { verdict: "invalid", message };
        }
      }
    }
  }
  return { results, status: keysStatus() };
}

/** Aborts the in-flight inference stream when a new one starts. */
let inferAbort: AbortController | null = null;

/**
 * Running session memory, split in two so code follow-ups always work:
 *  - pinnedSolutions: EVERY coding solution given since the last Master Clear, kept
 *    whole and in order. Follow-ups ("why this approach?", "what's the complexity?",
 *    "make it iterative", "go back to the first one") are answered against them no
 *    matter how many turns happen afterwards — they are never evicted by later chat.
 *    A list rather than one slot because interviewers routinely put a second problem
 *    on the same page: pressing Code again used to overwrite the first solution and
 *    silently break every follow-up about it.
 *  - recentTurns: a rolling, capped log of the other turns (answers, explanations).
 * Both persist under userData so an app crash/restart mid-interview keeps them;
 * Master Clear wipes them.
 */
let pinnedSolutions: string[] = [];
let recentTurns = "";

/** Cap per solution (a whole solution comfortably fits). */
const MAX_PINNED_CHARS = 6_000;

/**
 * How many solutions to keep, and their combined budget. Every one is sent with every
 * later request, so this trades recall against prompt size (and answer latency).
 * Six covers a whole interview; the oldest is dropped past either limit.
 */
const MAX_PINNED_SOLUTIONS = 6;
const MAX_PINNED_TOTAL_CHARS = 14_000;

/** Rolling cap for the other turns; keeps the most recent context. */
const MAX_RECENT_CHARS = 6_000;

/** Restore persisted memory only when this fresh — i.e. a mid-interview restart. */
const MEMORY_RESUME_WINDOW_MS = 3 * 60 * 60 * 1000;

function memoryPath(): string {
  return path.join(app.getPath("userData"), "session-memory.json");
}

/** Best-effort write of the session memory to disk (survives an app restart). */
function persistMemory(): void {
  try {
    fs.writeFileSync(
      memoryPath(),
      JSON.stringify({ pinnedSolutions, recentTurns, savedAt: Date.now() }),
    );
  } catch (err) {
    diag(`MEMORY persist failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Reloads persisted memory on startup, but only within the resume window so a
 *  fresh interview never starts polluted by last week's session. */
function restoreMemory(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(memoryPath(), "utf8")) as Record<string, unknown>;
    const savedAt = typeof raw.savedAt === "number" ? raw.savedAt : 0;
    if (Date.now() - savedAt > MEMORY_RESUME_WINDOW_MS) return;
    pinnedSolutions = Array.isArray(raw.pinnedSolutions)
      ? raw.pinnedSolutions.filter((s): s is string => typeof s === "string")
      : // Older builds stored a single solution under `pinnedSolution`.
        typeof raw.pinnedSolution === "string" && raw.pinnedSolution
        ? [raw.pinnedSolution]
        : [];
    recentTurns = typeof raw.recentTurns === "string" ? raw.recentTurns : "";
    if (pinnedSolutions.length || recentTurns) {
      diag(
        `MEMORY restored from previous session (${pinnedSolutions.length} solution(s), mid-interview restart)`,
      );
    }
  } catch {
    // No prior memory (or unreadable) — start fresh.
  }
}

/** Wipes both memory halves and the on-disk copy (Master Clear / new problem). */
function clearMemory(): void {
  pinnedSolutions = [];
  recentTurns = "";
  try {
    fs.rmSync(memoryPath(), { force: true });
  } catch {
    // Best-effort only.
  }
}

/**
 * The combined memory block fed to every AI call: the pinned solutions first, then
 * the rolling turns. Solutions are NUMBERED and the newest is explicitly flagged, so
 * the model can tell them apart when several are in play and knows which one an
 * unqualified "why did you do it that way?" refers to.
 */
function sessionMemoryText(): string {
  const parts: string[] = [];
  if (pinnedSolutions.length > 0) {
    const blocks = pinnedSolutions.map((solution, index) => {
      const isLast = index === pinnedSolutions.length - 1;
      const label = `CODING SOLUTION ${index + 1} of ${pinnedSolutions.length}${
        isLast ? " (MOST RECENT — the code currently on screen)" : ""
      }`;
      return `--- ${label} ---\n${solution}`;
    });
    parts.push(
      "THE CODE THE USER HAS WRITTEN THIS SESSION. Any question about 'the code', its " +
        "complexity, why an approach was chosen, an edge case, a bug, or a requested " +
        "modification refers to these — answer from them directly and never ask the user to " +
        "paste code. Unless the interviewer clearly points at an earlier problem, assume they " +
        "mean the MOST RECENT solution. When asked to modify, continue from the relevant " +
        `solution and change only what is needed.\n\n${blocks.join("\n\n")}`,
    );
  }
  if (recentTurns) parts.push(recentTurns);
  return parts.join("\n\n");
}

/**
 * Pins a coding solution, keeping the earlier ones. Trimmed to the newest
 * MAX_PINNED_SOLUTIONS and MAX_PINNED_TOTAL_CHARS so a long session cannot grow the
 * prompt without bound (every solution is resent on every later request).
 */
function rememberCodingSolution(solution: string): void {
  const trimmed = solution.trim().slice(0, MAX_PINNED_CHARS);
  if (!trimmed) return;
  pinnedSolutions.push(trimmed);
  while (pinnedSolutions.length > MAX_PINNED_SOLUTIONS) pinnedSolutions.shift();
  while (
    pinnedSolutions.length > 1 &&
    pinnedSolutions.reduce((sum, s) => sum + s.length, 0) > MAX_PINNED_TOTAL_CHARS
  ) {
    pinnedSolutions.shift();
  }
  persistMemory();
  diag(`MEMORY pinned solution #${pinnedSolutions.length} (kept ${pinnedSolutions.length})`);
  logConversation("Coding solution given", solution);
}

/**
 * One file per meeting, numbered in the order they happened: "meeting 1.txt",
 * "meeting 2.txt", and so on.
 *
 * Everything lands in the same file, interleaved as it happens: each line as it is
 * spoken, and each answer directly under the line that prompted it. A meeting is then
 * one readable document rather than a transcript and an answer log to reconcile by
 * timestamp afterwards.
 *
 * The folder is MEETING_NOTES_DIR when set (see .env), otherwise Documents/<app>.
 */
let meetingLogPath = "";

/** The folder meeting notes are written to, created if needed. */
function meetingNotesDir(): string {
  const configured = process.env.MEETING_NOTES_DIR?.trim();
  for (const dir of [configured, path.join(app.getPath("documents"), APP_NAME)]) {
    if (!dir) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      // Unwritable (a bad path, a disconnected drive) - fall through to the next.
    }
  }
  return app.getPath("userData");
}

/**
 * Next free meeting number in `dir`: one past the highest already there, so numbering
 * survives restarts and never overwrites an earlier meeting.
 */
function nextMeetingNumber(dir: string): number {
  let highest = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const match = /^meeting (\d+)\.txt$/i.exec(name);
      if (match) highest = Math.max(highest, Number(match[1]));
    }
  } catch {
    // Unreadable folder - start from 1 rather than failing the write.
  }
  return highest + 1;
}

/** Returns (creating if needed) this session's meeting file. */
function ensureMeetingLog(): string {
  if (meetingLogPath) return meetingLogPath;
  const dir = meetingNotesDir();
  const number = nextMeetingNumber(dir);
  meetingLogPath = path.join(dir, `meeting ${String(number)}.txt`);
  try {
    fs.writeFileSync(
      meetingLogPath,
      [
        `${APP_NAME} - meeting ${String(number)}`,
        `Started ${new Date().toLocaleString()}`,
        "",
        "Every line as it was spoken, with the answers given. Written live, so this stays",
        "complete even if an answer fails or the app is closed without exporting anything.",
        "",
        "",
      ].join("\n"),
    );
    diag(`NOTES writing meeting ${String(number)} to ${meetingLogPath}`);
  } catch (err) {
    diag(`meeting log header failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return meetingLogPath;
}

/** Appends a labelled entry (an answer, a coding solution) under the line that prompted it. */
function logConversation(label: string, text: string): void {
  try {
    const stamp = new Date().toLocaleTimeString();
    const body = text
      .trim()
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
    fs.appendFileSync(ensureMeetingLog(), `[${stamp}] ${label}\n${body}\n\n`);
  } catch (err) {
    diag(`meeting log failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Appends one finalised transcript line, verbatim, as it is spoken.
 *
 * Recorded independently of whether an answer follows: an answer can fail, and the turn
 * still belongs in the record. This is what makes the file a complete meeting rather
 * than a list of the questions that happened to succeed.
 */
function logTranscriptLine(speaker: "you" | "them", text: string): void {
  const line = text.trim();
  if (!line) return;
  try {
    const stamp = new Date().toLocaleTimeString();
    const who = speaker === "you" ? "You " : "Them";
    fs.appendFileSync(ensureMeetingLog(), `[${stamp}] ${who}: ${line}\n`);
  } catch (err) {
    diag(`meeting log failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Appends a labelled turn to the rolling memory (capped) and the conversation log. */
function rememberTurn(label: string, text: string): void {
  const turn = `--- ${label} ---\n${text.trim()}`;
  recentTurns = `${recentTurns}\n\n${turn}`.trim().slice(-MAX_RECENT_CHARS);
  persistMemory();
  // The label repeats the question for the rolling memory; the file already has it as a
  // spoken line directly above, so only the answer itself is written there.
  logConversation("ANSWER GIVEN", text);
}

function isContextLine(value: unknown): value is InferContextLine {
  if (typeof value !== "object" || value === null) return false;
  const line = value as Record<string, unknown>;
  return (line.speaker === "you" || line.speaker === "them") && typeof line.text === "string";
}

/** Runs one inference stream, forwarding deltas/done/error to the overlay. */
async function runInference(context: InferContextLine[]): Promise<InferRunResult> {
  if (context.length === 0) {
    return { ok: false, error: "No transcript yet — start capture and speak first." };
  }

  inferAbort?.abort();
  const abort = new AbortController();
  inferAbort = abort;

  const settings = readSettings();
  const lastThem = [...context].reverse().find((line) => line.speaker === "them")?.text ?? "";
  let answer = "";
  try {
    await streamAnswer({
      context,
      // parseInterviewRole also migrates any role slug saved by an earlier build.
      role: parseInterviewRole(settings.role),
      preferProvider: parseAnswerProvider(settings.answerProvider),
      sessionMemory: sessionMemoryText() || undefined,
      signal: abort.signal,
      onDelta: (text) => {
        answer += text;
        overlay?.webContents.send(IpcChannel.InferDelta, text);
      },
    });
    if (answer.trim()) rememberTurn(`Interviewer asked: ${lastThem}\nAnswer given`, answer);
    if (inferAbort === abort) inferAbort = null;
    overlay?.webContents.send(IpcChannel.InferDone);
    return { ok: true };
  } catch (err) {
    if (abort.signal.aborted) {
      return { ok: false, error: "cancelled" };
    }
    const message =
      err instanceof InferError ? err.message : err instanceof Error ? err.message : String(err);
    overlay?.webContents.send(IpcChannel.InferError, message);
    return { ok: false, error: message };
  }
}

/**
 * Captures the primary display as a PNG data URL. The overlay has content
 * protection ON, so it is excluded from this capture — only the coding question
 * behind it is grabbed. The longest edge is capped so the vision call stays fast.
 */
async function captureScreenDataUrl(): Promise<string> {
  const display = screen.getPrimaryDisplay();
  const fullWidth = Math.round(display.size.width * display.scaleFactor);
  const fullHeight = Math.round(display.size.height * display.scaleFactor);
  const scale = Math.min(1, MAX_CAPTURE_EDGE / Math.max(fullWidth, fullHeight));
  const thumbnailSize = {
    width: Math.max(1, Math.round(fullWidth * scale)),
    height: Math.max(1, Math.round(fullHeight * scale)),
  };

  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize,
    fetchWindowIcons: false,
  });
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
  if (!source || source.thumbnail.isEmpty()) {
    throw new InferError("Could not capture the screen. Try again once the question is visible.");
  }
  // JPEG (quality 80) instead of PNG: a screenshot PNG can be several MB, which makes
  // the upload to the vision model heavy and prone to "fetch failed". JPEG is ~10x smaller.
  const jpeg = source.thumbnail.toJPEG(80);
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

/** Screenshots the screen and streams a coding solution into the overlay's answer box. */
async function runCodingInference(context: InferContextLine[]): Promise<InferRunResult> {
  inferAbort?.abort();
  const abort = new AbortController();
  inferAbort = abort;

  // Recent transcript so a verbally-modified question ("now make it a BST") is understood.
  const recentTranscript = context
    .slice(-8)
    .map((line) => `${line.speaker === "you" ? "You" : "Them"}: ${line.text}`)
    .join("\n");

  try {
    const imageDataUrl = await captureScreenDataUrl();
    let solution = "";
    // One streaming attempt. Resets `solution` so a retry doesn't duplicate text.
    const attempt = async (): Promise<void> => {
      solution = "";
      await streamCodingAnswer({
        imageDataUrl,
        recentTranscript,
        sessionMemory: sessionMemoryText() || undefined,
        signal: abort.signal,
        onDelta: (text) => {
          solution += text;
          overlay?.webContents.send(IpcChannel.InferDelta, text);
        },
      });
    };

    try {
      await attempt();
    } catch (err) {
      // Transient network failure ("fetch failed") before anything streamed → retry once.
      // A rate limit is NOT transient: retrying just burns another full timeout before
      // failing the same way, which is most of the long wait the user sees.
      const message = err instanceof Error ? err.message : String(err);
      const rateLimited = /rate limit/i.test(message);
      if (!abort.signal.aborted && solution === "" && !rateLimited) {
        await attempt();
      } else {
        throw err;
      }
    }

    if (solution.trim()) rememberCodingSolution(solution);
    if (inferAbort === abort) inferAbort = null;
    overlay?.webContents.send(IpcChannel.InferDone);
    return { ok: true };
  } catch (err) {
    if (abort.signal.aborted) {
      return { ok: false, error: "cancelled" };
    }
    const raw =
      err instanceof InferError ? err.message : err instanceof Error ? err.message : String(err);
    // "fetch failed" is undici's generic network error — make it actionable.
    const message = /fetch failed/i.test(raw)
      ? "Network error reaching the vision model. Check your internet and press Ctrl+Shift+C again."
      : raw;
    overlay?.webContents.send(IpcChannel.InferError, message);
    return { ok: false, error: message };
  }
}

/** Streams pseudo code derived from the most recent coding solution in memory. */
async function runPseudocodeInference(): Promise<InferRunResult> {
  // Pseudocode specifically derives from a coding solution — require at least one
  // (the old check passed on ANY memory, even when no code had been solved yet).
  if (pinnedSolutions.length === 0) {
    return { ok: false, error: "no-code" };
  }

  inferAbort?.abort();
  const abort = new AbortController();
  inferAbort = abort;

  try {
    await streamPseudocode({
      sessionMemory: sessionMemoryText(),
      signal: abort.signal,
      onDelta: (text) => overlay?.webContents.send(IpcChannel.InferDelta, text),
    });
    if (inferAbort === abort) inferAbort = null;
    overlay?.webContents.send(IpcChannel.InferDone);
    return { ok: true };
  } catch (err) {
    if (abort.signal.aborted) {
      return { ok: false, error: "cancelled" };
    }
    const message =
      err instanceof InferError ? err.message : err instanceof Error ? err.message : String(err);
    overlay?.webContents.send(IpcChannel.InferError, message);
    return { ok: false, error: message };
  }
}

/** Screenshots the screen and streams a spoken-style explanation of the on-screen code. */
async function runExplainInference(context: InferContextLine[]): Promise<InferRunResult> {
  inferAbort?.abort();
  const abort = new AbortController();
  inferAbort = abort;

  const recentTranscript = context
    .slice(-8)
    .map((line) => `${line.speaker === "you" ? "You" : "Them"}: ${line.text}`)
    .join("\n");

  let explanation = "";
  try {
    const imageDataUrl = await captureScreenDataUrl();
    await streamExplain({
      imageDataUrl,
      sessionMemory: sessionMemoryText() || undefined,
      recentTranscript,
      signal: abort.signal,
      onDelta: (text) => {
        explanation += text;
        overlay?.webContents.send(IpcChannel.InferDelta, text);
      },
    });
    if (explanation.trim()) rememberTurn("Explanation given", explanation);
    if (inferAbort === abort) inferAbort = null;
    overlay?.webContents.send(IpcChannel.InferDone);
    return { ok: true };
  } catch (err) {
    if (abort.signal.aborted) {
      return { ok: false, error: "cancelled" };
    }
    const raw =
      err instanceof InferError ? err.message : err instanceof Error ? err.message : String(err);
    const message = /fetch failed/i.test(raw)
      ? "Network error reaching the vision model. Check your internet and try again."
      : raw;
    overlay?.webContents.send(IpcChannel.InferError, message);
    return { ok: false, error: message };
  }
}

function isNotesQuestion(value: unknown): value is NotesQuestion {
  if (typeof value !== "object" || value === null) return false;
  const q = value as Record<string, unknown>;
  return typeof q.time === "string" && typeof q.text === "string" && q.text.trim() !== "";
}

/**
 * Writes the questions asked this session to a .txt under Documents/Aced
 * and opens it (the Notes button — the end-of-meeting review sheet).
 */
async function openQuestionNotes(raw: unknown): Promise<NotesOpenResult> {
  const questions = Array.isArray(raw) ? raw.filter(isNotesQuestion) : [];
  if (questions.length === 0) {
    return {
      ok: false,
      error: "No questions captured yet — they are collected as the interviewer speaks.",
    };
  }
  try {
    const dir = path.join(app.getPath("documents"), APP_NAME);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // Fall back to userData if Documents isn't writable.
    }
    const base = fs.existsSync(dir) ? dir : app.getPath("userData");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const file = path.join(base, `questions-${stamp}.txt`);
    const header = [
      `${APP_NAME} — questions asked this session (exported ${new Date().toLocaleString()})`,
      "System audio mode captures the interviewer only; Phone mode captures both voices.",
      "",
    ];
    const lines = questions.map(
      (q, index) => `${String(index + 1).padStart(2, " ")}. [${q.time}] ${q.text}`,
    );
    fs.writeFileSync(file, [...header, ...lines, ""].join("\n"));
    diag(`NOTES exported ${questions.length} question(s) to ${file}`);
    const openError = await shell.openPath(file);
    if (openError) {
      return { ok: false, error: `Notes saved to ${file} but could not be opened: ${openError}` };
    }
    return { ok: true, path: file };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Width of the low-res screen grab used for backdrop sampling (kept tiny: it runs ~1/s). */
const BACKDROP_THUMB_WIDTH = 384;

/**
 * Default height of the compact dim bar — roughly a full 4-line answer plus the Dim
 * button. Only a starting point: Ctrl+Shift+= / - and dragging the edge both adjust
 * it, and whatever size you land on is reused for the rest of the session.
 */
const COMPACT_HEIGHT = 215;

/** The window's normal bounds, saved while the compact dim bar is showing. */
let normalBounds: Electron.Rectangle | null = null;

/** The size the user last dragged the compact bar to; reused on the next dim. */
let compactSize: { width: number; height: number } | null = null;

/**
 * Collapses the window to the compact dim bar (answer + Dim button only) and back.
 * The renderer hides the rest via CSS; this just resizes. The minimum size has to be
 * relaxed first — the normal 360x520 floor would otherwise block the shrink — and the
 * position is preserved so the bar stays where the overlay was. The bar stays
 * resizable, and whatever size you drag it to is reused next time.
 */
function setCompactWindow(compact: boolean): void {
  if (!overlay || overlay.isDestroyed()) return;
  if (compact) {
    if (normalBounds) return;
    const bounds = overlay.getBounds();
    normalBounds = bounds;
    overlay.setMinimumSize(240, 90);
    overlay.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: compactSize?.width ?? bounds.width,
      height: compactSize?.height ?? COMPACT_HEIGHT,
    });
    return;
  }
  const restore = normalBounds;
  if (!restore) return;
  // Restore the SIZE at the bar's CURRENT position: dragging the compact bar somewhere
  // better is a deliberate choice, and snapping back to the pre-dim spot threw it away.
  const current = overlay.getBounds();
  // Clear first: the resize handler below treats a non-null normalBounds as "we are
  // compact", so restoring the full size would otherwise be recorded as the bar size.
  normalBounds = null;
  overlay.setBounds({
    x: current.x,
    y: current.y,
    width: restore.width,
    height: restore.height,
  });
  overlay.setMinimumSize(360, 520);
}

/**
 * Average COLOUR of the screen area BEHIND the overlay, for the adaptive privacy dim.
 * Used when the renderer has no screen-share video track to sample (before Start, or
 * in Phone mode). The overlay has content protection ON, so it is excluded from this
 * capture — the reading is the true backdrop, never our own text. Returns null when
 * it can't be measured; the caller then keeps its last tone.
 */
async function sampleBackdropColor(): Promise<BackdropColor | null> {
  if (!overlay || overlay.isDestroyed() || !overlay.isVisible()) return null;
  try {
    const display = screen.getPrimaryDisplay();
    const aspect = display.size.height / Math.max(1, display.size.width);
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: {
        width: BACKDROP_THUMB_WIDTH,
        height: Math.max(1, Math.round(BACKDROP_THUMB_WIDTH * aspect)),
      },
      fetchWindowIcons: false,
    });
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
    if (!source || source.thumbnail.isEmpty()) return null;

    const thumb = source.thumbnail.getSize();
    const scaleX = thumb.width / Math.max(1, display.size.width);
    const scaleY = thumb.height / Math.max(1, display.size.height);
    const bounds = overlay.getBounds();
    const x = Math.min(Math.max(Math.round(bounds.x * scaleX), 0), thumb.width - 1);
    const y = Math.min(Math.max(Math.round(bounds.y * scaleY), 0), thumb.height - 1);
    const width = Math.min(Math.max(Math.round(bounds.width * scaleX), 1), thumb.width - x);
    const height = Math.min(Math.max(Math.round(bounds.height * scaleY), 1), thumb.height - y);

    // toBitmap() is BGRA, 4 bytes per pixel (getBitmap is mistyped as void here).
    const bitmap = source.thumbnail.crop({ x, y, width, height }).toBitmap();
    if (bitmap.length === 0) return null;
    let blue = 0;
    let green = 0;
    let red = 0;
    let pixels = 0;
    for (let i = 0; i + 2 < bitmap.length; i += 4) {
      blue += bitmap[i]!;
      green += bitmap[i + 1]!;
      red += bitmap[i + 2]!;
      pixels += 1;
    }
    if (pixels === 0) return null;
    return { r: red / pixels, g: green / pixels, b: blue / pixels };
  } catch (err) {
    diag(`backdrop sample failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Mints a short-lived STT credential for the requested provider. */
async function mintSttToken(provider: unknown): Promise<SttTokenResult> {
  try {
    if (provider === "deepgram") {
      const grant = await mintDeepgramToken();
      return { ok: true, ...grant };
    }
    if (provider === "elevenlabs") {
      const grant = await mintElevenLabsToken();
      return { ok: true, ...grant };
    }
    return { ok: false, error: `No token flow for provider: ${String(provider)}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Starts (or reuses) the local Sarvam relay and returns its WebSocket URL. */
async function getSarvamRelay(): Promise<SarvamRelayResult> {
  try {
    const port = await startSarvamRelay();
    return { ok: true, url: `ws://127.0.0.1:${port}${SARVAM_RELAY_PATH}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Diagnostics log. The overlay is frameless and has no visible console, so we
 * also append startup diagnostics to a file under the app's userData dir.
 */
function diag(message: string): void {
  // Console first, but never let a dead stdout (terminal closed after launch) turn a
  // log line into a crash — the file below is the log that actually matters.
  try {
    console.log(`[${APP_NAME}] ${message}`);
  } catch {
    // No console attached.
  }
  try {
    const file = path.join(app.getPath("userData"), "diagnostics.log");
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // Best-effort logging only.
  }
}

/**
 * Registers a global shortcut and REPORTS the result. register() silently returns
 * false when another app already owns the combo, which previously left dead hotkeys
 * with no diagnostic at all — the failure mode is invisible right when it matters.
 */
function registerHotkey(accelerator: string, label: string, handler: () => void): void {
  const registered = globalShortcut.register(accelerator, handler);
  diag(
    `HOTKEY ${label} (${accelerator}) ${
      registered ? "registered" : "FAILED — another app already owns this combo"
    }`,
  );
}

function isOverlayWebContents(contents: Electron.WebContents | null | undefined): boolean {
  return overlay !== null && contents?.id === overlay.webContents.id;
}

function isOverlayFrame(frame: Electron.WebFrameMain | null): boolean {
  if (frame === null) return false;
  return isOverlayWebContents(webContents.fromFrame(frame));
}

function configureCaptureSession(): void {
  const defaultSession = session.defaultSession;

  defaultSession.setPermissionCheckHandler((contents, permission) => {
    return permission === "media" && isOverlayWebContents(contents);
  });

  defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    const allowed =
      isOverlayWebContents(contents) &&
      (permission === "media" || permission === "display-capture");
    diag(`PERMISSION_REQUEST ${permission} ${allowed ? "granted" : "denied"}`);
    callback(allowed);
  });

  defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    if (!isOverlayFrame(request.frame)) {
      diag(`DISPLAY_MEDIA denied origin=${request.securityOrigin}`);
      callback({});
      return;
    }

    desktopCapturer
      .getSources({
        types: ["screen"],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false,
      })
      .then((sources) => {
        const source = sources[0];
        if (!source) {
          diag("DISPLAY_MEDIA failed: no screen sources available");
          callback({});
          return;
        }

        diag(
          `DISPLAY_MEDIA granting source="${source.name}" audio=${
            request.audioRequested ? "loopback" : "none"
          } video=${request.videoRequested ? "screen" : "not-requested"}`,
        );
        callback({
          video: source,
          ...(request.audioRequested ? { audio: "loopback" as const } : {}),
        });
      })
      .catch((err: unknown) => {
        diag(`DISPLAY_MEDIA failed: ${err instanceof Error ? err.message : String(err)}`);
        callback({});
      });
  });
}

/** Startup diagnostics shown in the overlay's hidden log (and the diag file). */
function buildStatusEntries(): StatusEntry[] {
  const display = screen.getPrimaryDisplay();
  const config = buildAppConfig();
  return [
    { label: "App", value: `${APP_NAME} — AI interview overlay` },
    { label: "STT provider", value: config.sttProvider },
    { label: "Groq key", value: config.groqReady ? "present" : "MISSING" },
    { label: "Deepgram key", value: config.availableProviders.deepgram ? "present" : "MISSING" },
    { label: "Electron", value: process.versions.electron ?? "unknown" },
    { label: "Platform", value: `${process.platform} ${process.arch}` },
    { label: "Content protection", value: "ENABLED (excluded from screen capture)" },
    {
      label: "Primary display",
      value: `${display.size.width}x${display.size.height} @ ${display.scaleFactor}x`,
    },
    { label: "Quit", value: "click x or press Ctrl+Shift+Q" },
  ];
}

/*
 * There is deliberately NO tray icon.
 *
 * A tray icon is passively visible whenever the user shares their whole screen (the
 * taskbar is captured), its hover tooltip names the app, and its right-click menu is
 * a native OS menu that window content protection cannot cover. Everything it offered
 * already has a global hotkey — Ctrl+Shift+H shows/hides, Ctrl+Shift+Q quits,
 * Ctrl+D kills — so it was pure exposure for no capability.
 */

function createWindow(): void {
  overlay = new BrowserWindow({
    width: 460,
    height: 740,
    minWidth: 360,
    minHeight: 520,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Raise above normal always-on-top windows (screen-saver level) and hide from capture.
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setContentProtection(true);
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Re-assert capture exclusion every time the overlay is shown (e.g. after the
  // hide/show hotkey or tray restore), so it can never lapse into being visible
  // to a screen-share mid-meeting.
  overlay.on("show", () => {
    overlay?.setContentProtection(true);
    overlay?.setAlwaysOnTop(true, "screen-saver");
  });

  /*
   * Tell the renderer the window settled somewhere new, so the adaptive dim can
   * re-read the backdrop. Debounced: "move" fires continuously during a native drag,
   * and each re-read is a screen grab that blocks this process for over a second.
   */
  overlay.on("move", () => {
    if (movedNotifyTimer) clearTimeout(movedNotifyTimer);
    movedNotifyTimer = setTimeout(() => {
      movedNotifyTimer = null;
      overlay?.webContents.send(IpcChannel.WindowMoved);
    }, 350);
  });

  // Remember the size the compact bar is dragged to, so it persists across toggles.
  overlay.on("resize", () => {
    if (!overlay || normalBounds === null) return;
    const bounds = overlay.getBounds();
    compactSize = { width: bounds.width, height: bounds.height };
  });

  overlay.once("ready-to-show", () => overlay?.show());

  overlay.webContents.on("did-finish-load", () => {
    for (const entry of buildStatusEntries()) {
      diag(`${entry.label}: ${entry.value}`);
      overlay?.webContents.send(IpcChannel.Log, entry);
    }
    diag("WINDOW_READY content-protection=ON");
  });

  void overlay.loadFile(path.join(__dirname, "renderer", "index.html"));
}

// A single instance owns the overlay; a second launch just focuses the first.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (overlay) {
      if (overlay.isMinimized()) overlay.restore();
      overlay.show();
      overlay.focus();
    }
  });

  ipcMain.handle(IpcChannel.GetConfig, () => buildAppConfig());
  ipcMain.handle(IpcChannel.SetAnswerProvider, (_event, provider: unknown) => {
    const choice = parseAnswerProvider(provider);
    writeSettings({ ...readSettings(), answerProvider: choice });
    diag(`ANSWER provider preference set to ${choice}`);
    return buildAppConfig();
  });
  ipcMain.handle(IpcChannel.SetSttProvider, (_event, provider: unknown) => {
    if (typeof provider === "string" && (STT_PROVIDERS as readonly string[]).includes(provider)) {
      activeSttProvider = provider as SttProvider;
      writeSettings({ ...readSettings(), sttProvider: activeSttProvider });
      diag(`STT provider switched to ${activeSttProvider}`);
    }
    return buildAppConfig();
  });
  ipcMain.handle(IpcChannel.GetUserContext, () => {
    return { role: parseInterviewRole(readSettings().role) };
  });
  ipcMain.handle(IpcChannel.SetUserContext, (_event, context: unknown) => {
    if (typeof context !== "object" || context === null) return;
    const candidate = context as Record<string, unknown>;
    const role = parseInterviewRole(
      typeof candidate.role === "string" ? candidate.role : undefined,
    );
    writeSettings({ ...readSettings(), role });
    diag(`USER_CONTEXT saved (role=${role})`);
  });
  ipcMain.on(IpcChannel.TranscriptLine, (_event, speaker: unknown, text: unknown) => {
    if ((speaker !== "you" && speaker !== "them") || typeof text !== "string") return;
    logTranscriptLine(speaker, text);
  });
  ipcMain.handle(IpcChannel.KeysGet, () => keysStatus());
  ipcMain.handle(IpcChannel.KeysSave, (_event, entries: unknown) => saveKeyEntries(entries));
  ipcMain.handle(IpcChannel.SttToken, (_event, provider: unknown) => mintSttToken(provider));
  ipcMain.handle(IpcChannel.NotesOpen, (_event, questions: unknown) =>
    openQuestionNotes(questions),
  );
  ipcMain.handle(IpcChannel.BackdropSample, () => sampleBackdropColor());
  ipcMain.handle(IpcChannel.SetCompact, (_event, compact: unknown) => {
    setCompactWindow(compact === true);
  });
  ipcMain.handle(IpcChannel.SetDimDelta, (_event, delta: unknown) => {
    if (typeof delta !== "number" || !Number.isFinite(delta)) return;
    writeSettings({ ...readSettings(), dimDelta: Math.round(delta) });
  });
  ipcMain.handle(IpcChannel.SarvamRelay, () => getSarvamRelay());
  ipcMain.handle(IpcChannel.InferRun, (_event, context: unknown) => {
    const lines = Array.isArray(context) ? context.filter(isContextLine) : [];
    return runInference(lines);
  });
  ipcMain.handle(IpcChannel.CodingRun, (_event, context: unknown) => {
    const lines = Array.isArray(context) ? context.filter(isContextLine) : [];
    return runCodingInference(lines);
  });
  ipcMain.handle(IpcChannel.PseudocodeRun, () => runPseudocodeInference());
  ipcMain.handle(IpcChannel.ExplainRun, (_event, context: unknown) => {
    const lines = Array.isArray(context) ? context.filter(isContextLine) : [];
    return runExplainInference(lines);
  });
  ipcMain.handle(
    IpcChannel.TurnComplete,
    (_event, utterance: unknown): Promise<TurnCompleteResponse> | TurnCompleteResponse => {
      // Fail open on a bad payload too: an unusable utterance shouldn't stall the gate.
      if (typeof utterance !== "string" || !utterance.trim()) {
        return { complete: true, source: "error" };
      }
      return classifyTurnComplete(utterance);
    },
  );

  app
    .whenReady()
    .then(() => {
      try {
        fs.writeFileSync(path.join(app.getPath("userData"), "diagnostics.log"), "");
      } catch {
        // Best-effort only.
      }
      // Keys saved in the Keys panel. Needs 'ready' (Windows decryption), and must run
      // before the window asks which providers are configured.
      loadSavedKeys(diag);
      activeSttProvider = resolveInitialProvider();
      restoreMemory();
      // Provider failures (rate limits, auth, empty responses) go to diagnostics.log
      // from here on; before this they only reached a stdout nobody was reading.
      setDiagnosticSink(diag);
      diag("app ready, creating overlay");
      configureCaptureSession();
      createWindow();
      registerHotkey("CommandOrControl+Shift+Q", "quit", () => app.quit());
      // Kill switch: fastest possible exit. Hide first so the window is gone from the
      // screen in the same frame, then terminate without unwinding anything.
      registerHotkey(KILL_HOTKEY, "kill", () => {
        overlay?.hide();
        globalShortcut.unregisterAll();
        // app.exit skips will-quit, so flush by hand or a just-changed setting is lost.
        // The window is already hidden by this point, so this costs nothing visible.
        flushSettings();
        app.exit(0);
      });
      registerHotkey(ASK_HOTKEY, "ask", () => {
        overlay?.webContents.send(IpcChannel.InferHotkey);
      });
      registerHotkey(CODING_HOTKEY, "code", () => {
        overlay?.webContents.send(IpcChannel.CodingHotkey);
      });
      registerHotkey(LOCK_HOTKEY, "lock", () => {
        overlay?.webContents.send(IpcChannel.LockHotkey);
      });
      registerHotkey(DIM_HOTKEY, "dim", () => {
        overlay?.webContents.send(IpcChannel.DimHotkey);
      });
      registerHotkey(DIM_FAINTER_HOTKEY, "dim fainter", () => {
        overlay?.webContents.send(IpcChannel.DimAdjust, -1);
      });
      registerHotkey(DIM_CLEARER_HOTKEY, "dim clearer", () => {
        overlay?.webContents.send(IpcChannel.DimAdjust, 1);
      });
      registerHotkey(TALLER_HOTKEY, "taller", () => nudgeWindowHeight(HEIGHT_STEP));
      registerHotkey(SHORTER_HOTKEY, "shorter", () => nudgeWindowHeight(-HEIGHT_STEP));
      registerHotkey(PSEUDOCODE_HOTKEY, "pseudocode", () => {
        overlay?.webContents.send(IpcChannel.PseudocodeHotkey);
      });
      registerHotkey(EXPLAIN_HOTKEY, "explain", () => {
        overlay?.webContents.send(IpcChannel.ExplainHotkey);
      });
      registerHotkey(TOGGLE_HOTKEY, "hide/show", () => {
        if (!overlay) return;
        if (overlay.isVisible()) {
          overlay.hide();
        } else {
          overlay.show();
        }
      });
      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    })
    .catch((err: unknown) => {
      console.error(`[${APP_NAME}] failed to start:`, err);
      app.quit();
    });

  ipcMain.on(IpcChannel.Close, () => app.quit());
  ipcMain.on(IpcChannel.ResetMemory, () => {
    clearMemory();
    logConversation("════════ NEW PROBLEM (Master Clear) ════════", "");
    diag("MEMORY reset (new problem)");
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    stopSarvamRelay();
    // Settings are debounced, so a quit within the flush window would otherwise lose
    // the last change (typically the dim level the user just set).
    flushSettings();
  });
}
