import type {
  InferContextLine,
  SpeechToTextAdapter,
  SttProvider,
  SttTranscriptEvent,
} from "@aced/shared";
import type { BackdropColor, KeyField, KeysStatus, NotesQuestion } from "../ipc.js";
import { createDropdown } from "./dropdown.js";
import { createSttAdapter } from "./stt/factory.js";
import { createCompletenessGate } from "./turn/completenessGate.js";
import { classifySpeech, noteAnswerShown, resetSelfVoice } from "./turn/selfVoice.js";
import { TurnDetector } from "./turn/turnDetector.js";

const overlayEl = document.querySelector(".overlay");
const logEl = document.getElementById("log");
const labelEl = document.getElementById("app-label");
const recDotEl = document.getElementById("rec-dot");
const closeBtn = document.getElementById("close-btn");
const startCaptureBtn = document.getElementById("start-capture-btn");
const stopCaptureBtn = document.getElementById("stop-capture-btn");
const themStatusEl = document.getElementById("them-status");
const themDotEl = document.getElementById("them-dot");
const sttStatusEl = document.getElementById("stt-status");
const providerSelectEl = document.getElementById("provider-select");
const answerProviderEl = document.getElementById("answer-provider");
const sourceSelectEl = document.getElementById("source-select");

// In-page dropdowns, NOT native <select>: a native popup is a separate OS window that
// Windows content protection does not cover, so its option list is visible in a screen
// share even though the overlay is not. See dropdown.ts.
const sttDropdown = providerSelectEl ? createDropdown(providerSelectEl) : null;
const answerDropdown = answerProviderEl ? createDropdown(answerProviderEl) : null;
const sourceDropdown = sourceSelectEl ? createDropdown(sourceSelectEl) : null;
sourceDropdown?.setOptions([
  { value: "system", label: "System audio" },
  { value: "phone", label: "Phone (mic)" },
]);
const transcriptLinesEl = document.getElementById("transcript-lines");
const answerTextEl = document.getElementById("answer-text");
const askBtn = document.getElementById("ask-btn");
const solveBtn = document.getElementById("solve-btn");
const pseudoBtn = document.getElementById("pseudo-btn");
const lockBtn = document.getElementById("lock-btn");
const errorBannerEl = document.getElementById("error-banner");
const errorTextEl = document.getElementById("error-text");
const errorDismissBtn = document.getElementById("error-dismiss");
const clearBtn = document.getElementById("clear-btn");
const quickAskForm = document.getElementById("quick-ask");
const quickAskInput = document.getElementById("quick-ask-input");
const notesBtn = document.getElementById("notes-btn");
const dimBtn = document.getElementById("dim-btn");
const keysBtn = document.getElementById("keys-btn");
const keysPanelEl = document.getElementById("keys-panel");
const keysFormEl = document.getElementById("keys-form");
const keysSaveBtn = document.getElementById("keys-save");
const keysCloseBtn = document.getElementById("keys-close");
const keysMessageEl = document.getElementById("keys-message");
const KEY_FIELDS: KeyField[] = ["groq", "deepgram", "sarvam"];

const api = window.aced;
const audioRmsThreshold = 0.01;
const monitorIntervalMs = 250;
/** If no system audio is heard within this window after Start, warn the user. */
const noAudioWarnMs = 20000;
const maxTranscriptLines = 80;
const maxContextLines = 40;
/**
 * Lines actually sent to the model per ask. Smaller prompt = faster first token;
 * the last 12 lines comfortably cover a multi-sentence question plus context.
 */
const maxInferLines = 12;

/**
 * System-audio-only: Aced transcribes the meeting's audio ("Them" — Zoom /
 * Meet / Teams captured via Windows loopback) and never opens the microphone, so
 * the user's own voice is never transcribed or sent to the AI.
 */

/** Finalised transcript lines, labelled, sent to inference when asked. */
const transcriptContext: InferContextLine[] = [];
let isAsking = false;
/**
 * Set when the turn detector fires while an answer is still streaming. The ask is
 * queued (never dropped — the detector has already reset its buffer) and re-fired
 * as soon as the current run finishes, using the by-then-updated transcript.
 */
let pendingAsk = false;
let turnDebug = false;
let activeProvider: SttProvider = "deepgram";
/** Which STT providers have a key configured — the pool for automatic fallback. */
let availableProviders: Partial<Record<SttProvider, boolean>> = {};
/** Fallback order tried when the selected provider cannot connect. */
const STT_PROVIDER_ORDER: SttProvider[] = ["deepgram", "elevenlabs", "sarvam"];

type CaptureStatus = "idle" | "pending" | "active" | "error";

interface AudioMonitor {
  stop: () => void;
}

interface CaptureState {
  micStream: MediaStream;
  /** Null in Phone mode (mic capture), where getDisplayMedia isn't used. */
  displayStream: MediaStream | null;
  systemAudioStream: MediaStream;
  monitors: AudioMonitor[];
  sttAdapter: SpeechToTextAdapter;
  sttUnsubscribe: Array<() => void>;
  /** Owns the silent channel-0 source (closed on stop). */
  auxContext: AudioContext | null;
}

let capture: CaptureState | null = null;
let isStartingCapture = false;

/**
 * Every completed interviewer turn this app session, in order — the source for the
 * Notes export. Recorded when the turn detector fires (a gated, complete question),
 * never from raw transcript fragments, and NOT wiped by Master Clear: the notes are
 * a meeting-level record, Master Clear is a per-problem reset.
 */
const sessionQuestions: NotesQuestion[] = [];

/**
 * Ceiling on the notes log. A real interview produces well under a hundred questions,
 * but the app can be left running all day across back-to-back calls, and this array is
 * copied wholesale to the main process on every Notes export. Past the cap the oldest
 * questions drop, so a forgotten session cannot grow the renderer's memory unbounded.
 */
const MAX_SESSION_QUESTIONS = 500;

/** Records one completed them-turn for the notes (skips blanks and hotkey re-fires). */
function recordQuestion(utterance: string): void {
  const text = utterance.trim();
  if (!text) return;
  const last = sessionQuestions[sessionQuestions.length - 1];
  if (last && last.text === text) return;
  sessionQuestions.push({ time: new Date().toLocaleTimeString(), text });
  if (sessionQuestions.length > MAX_SESSION_QUESTIONS) sessionQuestions.shift();
}

/** Notes button: main writes the questions file and opens it in the default editor. */
async function openNotes(): Promise<void> {
  try {
    const result = await api.notes.open([...sessionQuestions]);
    if (result.ok) {
      appendLog("Notes", `exported ${sessionQuestions.length} question(s) to ${result.path ?? ""}`);
    } else if (result.error) {
      showError(result.error);
    }
  } catch (err) {
    showError(getErrorMessage(err));
  }
}
/**
 * Semantic end-of-turn detector for the "them" channel (one per capture session).
 * When it decides the other speaker finished a question, it fires inference
 * automatically — no clicks needed.
 */
let turnDetector: TurnDetector | null = null;
const partialTranscriptLines = new Map<string, HTMLElement>();

function appendLog(label: string, value: string): void {
  console.log(`[${api.appName}] ${label}: ${value}`);
  if (!logEl) return;
  const line = document.createElement("div");
  line.className = "log-line";
  line.textContent = `[${new Date().toLocaleTimeString()}] ${label}: ${value}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function asButton(element: HTMLElement | null): HTMLButtonElement | null {
  return element instanceof HTMLButtonElement ? element : null;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function showError(message: string): void {
  if (!errorBannerEl) return;
  if (errorTextEl) errorTextEl.textContent = message;
  errorBannerEl.hidden = false;
}

function hideError(): void {
  if (errorBannerEl) errorBannerEl.hidden = true;
}

function requireAudioTracks(stream: MediaStream): MediaStreamTrack[] {
  const tracks = stream.getAudioTracks();
  if (tracks.length === 0) {
    throw new Error("Meeting stream has no audio tracks");
  }
  return tracks;
}

function setCaptureControls(): void {
  const startButton = asButton(startCaptureBtn);
  const stopButton = asButton(stopCaptureBtn);
  if (startButton) startButton.disabled = isStartingCapture || capture !== null;
  if (stopButton) stopButton.disabled = capture === null;
  // Don't switch STT or audio source mid-capture; stop first.
  const busy = isStartingCapture || capture !== null;
  sttDropdown?.setDisabled(busy);
  sourceDropdown?.setDisabled(busy);
  if (recDotEl) recDotEl.dataset.state = capture !== null ? "recording" : "";
}

function updateCaptureStatus(status: CaptureStatus, text: string): void {
  if (themStatusEl) themStatusEl.textContent = text;
  if (themDotEl) themDotEl.dataset.state = status;
}

function updateSttStatus(status: CaptureStatus, text: string): void {
  if (!sttStatusEl) return;
  sttStatusEl.textContent = text;
  sttStatusEl.dataset.state = status;
}

function logStreamReady(stream: MediaStream): void {
  const tracks = requireAudioTracks(stream);
  appendLog("Them", `stream live with ${tracks.length} audio track(s)`);
  for (const track of tracks) {
    track.addEventListener("ended", () => {
      appendLog("Them", "audio track ended");
      updateCaptureStatus("idle", "ended");
    });
  }
}

function calculateRms(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

function createAudioMonitor(stream: MediaStream): AudioMonitor {
  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  const samples = new Float32Array(analyser.fftSize);
  let hasDetectedAudio = false;

  analyser.fftSize = 2048;
  source.connect(analyser);
  updateCaptureStatus("pending", "listening");

  void audioContext.resume().catch((err: unknown) => {
    appendLog("Them", `audio monitor failed to start: ${getErrorMessage(err)}`);
    updateCaptureStatus("error", "monitor error");
  });

  // Watchdog: if no audio is heard within the window, the meeting app is almost
  // certainly routing audio to a device we don't capture. Warn with the fix so the
  // user is never left silently stuck on "listening".
  let warnedNoAudio = false;
  const watchdogId = window.setTimeout(() => {
    if (!hasDetectedAudio) {
      warnedNoAudio = true;
      updateCaptureStatus("pending", "waiting for audio");
      showError(
        "No audio heard yet — this is normal if no one is speaking. If someone IS talking in " +
          "the meeting and you still see this, the meeting app may be sending sound to another " +
          "device: Win+R → mmsys.cpl → Playback → set your speakers as BOTH Default Device and " +
          "Default Communication Device. This clears automatically once sound is detected.",
      );
    }
  }, noAudioWarnMs);

  const intervalId = window.setInterval(() => {
    const liveTracks = stream.getAudioTracks().filter((track) => track.readyState === "live");
    if (liveTracks.length === 0) {
      updateCaptureStatus("idle", "stopped");
      window.clearInterval(intervalId);
      return;
    }

    analyser.getFloatTimeDomainData(samples);
    if (!hasDetectedAudio && calculateRms(samples) >= audioRmsThreshold) {
      hasDetectedAudio = true;
      window.clearTimeout(watchdogId);
      // Sound arrived — clear the "no audio" warning if it was shown.
      if (warnedNoAudio) hideError();
      updateCaptureStatus("active", "audio detected");
    }
  }, monitorIntervalMs);

  return {
    stop: () => {
      window.clearTimeout(watchdogId);
      window.clearInterval(intervalId);
      source.disconnect();
      analyser.disconnect();
      void audioContext.close().catch(() => undefined);
    },
  };
}

function setTranscriptLineText(line: HTMLElement, transcript: string): void {
  const label = document.createElement("span");
  label.className = "transcript-speaker";
  label.dataset.side = "Them";
  label.textContent = "Them:";

  const text = document.createElement("span");
  text.className = "transcript-text";
  text.textContent = transcript;

  line.replaceChildren(label, text);
}

function removePartialTranscriptLines(): void {
  for (const line of partialTranscriptLines.values()) {
    line.remove();
  }
  partialTranscriptLines.clear();
}

function clearTranscript(): void {
  partialTranscriptLines.clear();
  transcriptLinesEl?.replaceChildren();
  transcriptContext.length = 0;
  // Drop remembered answers and the learned speaker id: a new problem (or a new call)
  // starts with no assumptions about whose voice is whose.
  resetSelfVoice();
}

/**
 * Master Clear: a full "new problem" reset — wipes the transcript, AI context, the
 * current answer, both render buffers, the remembered coding solution (in main),
 * and unlocks the box. Use it when moving to a fresh, unrelated question.
 */
function clearAll(): void {
  clearTranscript();
  pendingAsk = false;
  setAnswer("");
  hideError();
  if (locked) setLocked(false);
  api.resetMemory();
  appendLog("Overlay", "MASTER CLEAR — new problem (transcript, answer, memory reset)");
}

// The role picker is gone from the overlay: there is only one role now, so the panel
// was a button that opened a single-option dropdown. Main still resolves the role for
// the answer prompt from its own settings (defaulting to data-scientist), so nothing
// about the answers changes — this only removes dead UI.

/** Divider drawn between stacked spoken answers. */
const PROSE_SEPARATOR = "\n\n──────────\n\n";
/** How many recent spoken answers to keep stacked before dropping the oldest. */
const maxProseAnswers = 2;

/** Whether the current answer is prose (spoken Q&A) or code (coding mode). */
let answerMode: "prose" | "code" = "prose";
/** Accumulated prose; spoken answers stack here with separators (never wiped mid-session). */
let proseBuffer = "";
/** Accumulated code for the current coding answer. */
let codeBuffer = "";
/** True right after an ask fires: the next prose delta starts a fresh block below the last. */
let startNewProseBlock = false;
/** When locked, the answer box is frozen — nothing (auto, ask, or coding) changes it. */
let locked = false;

/**
 * Privacy dim: fades the overlay so someone sitting beside you can't read it while
 * it stays legible at your own distance. Toggled with Ctrl+Shift+D or the Dim button.
 */
let dimmed = false;

// --- Adaptive backdrop tone -------------------------------------------------
// A real call is neither white nor black: it's a mid-tone video of a person and
// their room, and it drifts as they move. The static CSS dim can only crush the
// backdrop toward grey; it can't tell which side of grey it landed on. So while
// dimmed we sample the screen region UNDER the overlay from the screen-share video
// track we already hold (audio is all we use it for otherwise) and slide the text
// greys to sit just below the backdrop's own tone. The overlay is excluded from
// that capture by content protection, so it never reacts to its own text.

/** How often the backdrop is measured from the (free) screen-share video track. */
const BACKDROP_SAMPLE_MS = 350;
/**
 * The screen-grab fallback is NOT polled on a short timer.
 *
 * Measured on this machine, ONE grab blocks the MAIN process for 1.1-1.8s: DXGI
 * duplication is unavailable, so Windows falls back to the slow GDI path. Polling it
 * sub-second left main permanently busy, and every other IPC message queued behind a
 * screen capture — which is exactly why dragging crawled and the Code button answered
 * a second late.
 *
 * It is event-driven instead: sampled when the backdrop can actually have changed
 * (dim switched on, the window finished moving), plus a slow heartbeat for content
 * changing under a stationary window. The cheap video-track path, used whenever
 * capture is running, still polls frequently.
 */
const BACKDROP_IPC_HEARTBEAT_MS = 20_000;
/** Settle delay after a drag, so moving the window costs one grab and not dozens. */
const BACKDROP_AFTER_MOVE_MS = 450;
/** Smoothing factor for the running average (higher = snappier, less steady). */
const BACKDROP_SMOOTHING = 0.7;
/** Ignore changes below this many luminance steps: motion is what catches the eye. */
const BACKDROP_MIN_STEP = 2;
/**
 * How far below the backdrop tone the body text sits — the single knob for how faint
 * the dimmed overlay is. Smaller = closer to the backdrop = harder to read (for
 * everyone, including you). Adjustable live with Ctrl+Shift+Up/Down and persisted,
 * so it can be tuned against a real call instead of guessed here.
 */
let dimTextDelta = 5;
/** Bounds for the adjustable delta: 1 is almost invisible, 30 is clearly readable. */
const DIM_DELTA_MIN = 1;
const DIM_DELTA_MAX = 30;
/**
 * The 7 usable faintness levels the hotkeys step through. Stepping the raw gap by 1
 * meant ~30 presses to cross the range; these are the values that actually look
 * different from each other, so one press is a visible change.
 */
const DIM_LEVELS = [1, 5, 10, 15, 20, 25, 30];
/**
 * Must match the contrast() in the dim rule so we predict the filtered backdrop.
 * 1 = the filter no longer changes luminance, so the panel keeps the backdrop's own
 * tone and the text tracks the true value.
 */
const BACKDROP_CRUSH = 1;
/** Opacity of the dynamic panel tint: enough to steady the text, low enough to blend. */
const PANEL_TINT_ALPHA = 0.3;

/** Smoothed average COLOUR of the screen under the overlay; null until measured. */
let backdropColor: BackdropColor | null = null;
/** The tone last written to the CSS variables, to avoid pointless restyles. */
let appliedTone: number | null = null;
/**
 * Whether the text currently sits DARKER (-1) or LIGHTER (+1) than the backdrop.
 * Darker is preferred (it draws the eye less), but over a dark backdrop there is no
 * room below — the tone clamps at near-black and the faintness control stops doing
 * anything — so we flip. Switched with a wide dead band (below 90 / above 140) so a
 * backdrop hovering near mid-grey can't oscillate and make the text visibly flicker.
 */
let toneDirection: 1 | -1 = -1;
let backdropSampler: { stop: () => void } | null = null;
/** Which source the active sampler reads from, so we only restart on a real change. */
let backdropSamplerKind: "none" | "video" | "ipc" = "none";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Clears the sampled overrides so the static CSS dim values apply again. */
function clearBackdropTone(): void {
  appliedTone = null;
  if (!(overlayEl instanceof HTMLElement)) return;
  for (const name of [
    "--mc-glass",
    "--mc-text",
    "--mc-text-secondary",
    "--mc-muted",
    "--mc-faint",
    "--mc-answer",
    "--mc-accent",
  ]) {
    overlayEl.style.removeProperty(name);
  }
}

/**
 * Slides the dim palette to sit just under the measured backdrop. `luma` is the raw
 * screen luminance; the backdrop-filter crushes it toward mid-grey first, so we
 * predict that value and place the text a fixed step BELOW it — darker-than-backdrop
 * reads far less prominently than lighter-than-backdrop at the same gap.
 */
function applyBackdropTone(color: BackdropColor, force = false): void {
  if (!(overlayEl instanceof HTMLElement)) return;
  const luma = 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
  const filtered = 127.5 + BACKDROP_CRUSH * (luma - 127.5);

  const previousDirection = toneDirection;
  if (filtered < 90) toneDirection = 1;
  else if (filtered > 140) toneDirection = -1;
  // Light-on-dark reads more prominently than dark-on-light at an equal gap, so trim
  // the gap slightly when we have to go lighter.
  const offset = toneDirection === 1 ? dimTextDelta * 0.8 : -dimTextDelta;
  const tone = Math.round(clamp(filtered + offset, 4, 250));
  if (!force && appliedTone !== null && Math.abs(tone - appliedTone) < BACKDROP_MIN_STEP) return;

  // A direction flip moves the text to the far side of the backdrop in one step (up
  // to ~50 tone points). Stretch the fade for that one change so it glides instead of
  // snapping — an abrupt shift is exactly the motion cue the dim exists to avoid.
  if (previousDirection !== toneDirection && appliedTone !== null) {
    overlayEl.style.setProperty("--mc-tone-fade", "1.6s");
    window.setTimeout(() => overlayEl.style.removeProperty("--mc-tone-fade"), 1800);
  }

  appliedTone = tone;
  appendLog("Dim", `backdrop luma ${Math.round(luma)} -> text tone ${tone} (gap ${dimTextDelta})`);

  const channel = (value: number): number => Math.round(clamp(value, 0, 255));
  /**
   * Shifts the BACKDROP'S OWN colour to the target lightness instead of painting a
   * neutral grey. Adding a constant to each channel preserves the hue and chroma, so
   * the text takes on the background's colour cast — grey text at matching brightness
   * still separates by hue over anything colourful (video, slides, coloured chrome).
   */
  const tinted = (awayFromBackdrop: number): string => {
    const shift = tone - luma + toneDirection * awayFromBackdrop;
    return `rgb(${channel(color.r + shift)}, ${channel(color.g + shift)}, ${channel(
      color.b + shift,
    )})`;
  };

  // The panel takes the backdrop's own colour, so the region matches its surroundings
  // in both brightness and hue rather than reading as a rectangle.
  overlayEl.style.setProperty(
    "--mc-glass",
    `rgba(${channel(color.r)}, ${channel(color.g)}, ${channel(color.b)}, ${PANEL_TINT_ALPHA})`,
  );
  // Shades are expressed as distance FROM the backdrop, following toneDirection:
  // positive = further away = more readable, negative = closer = fainter.
  overlayEl.style.setProperty("--mc-text", tinted(0));
  overlayEl.style.setProperty("--mc-text-secondary", tinted(-3));
  overlayEl.style.setProperty("--mc-muted", tinted(-5));
  overlayEl.style.setProperty("--mc-faint", tinted(-8));
  // The answer is what you actually read — keep it the most legible of the set.
  overlayEl.style.setProperty("--mc-answer", tinted(1));
  overlayEl.style.setProperty("--mc-accent", tinted(1));
}

/** Feeds one raw measurement through the smoothing filter and repaints the tone. */
function feedBackdropSample(sampled: BackdropColor): void {
  const smooth = (previous: number, next: number): number =>
    previous + (next - previous) * BACKDROP_SMOOTHING;
  backdropColor =
    backdropColor === null
      ? sampled
      : {
          r: smooth(backdropColor.r, sampled.r),
          g: smooth(backdropColor.g, sampled.g),
          b: smooth(backdropColor.b, sampled.b),
        };
  applyBackdropTone(backdropColor);
}

/** True while a screen grab is in flight, so requests cannot pile up. */
let backdropGrabBusy = false;
/** Pending "sample after the window settles" timer. */
let backdropSettleTimer: number | null = null;

/**
 * Asks main for one screen grab. Refuses while dragging or while a grab is already
 * running: a grab blocks main for over a second, and doing that mid-drag is what made
 * the window crawl behind the cursor.
 */
function requestBackdropSample(): void {
  if (!dimmed || backdropGrabBusy) return;
  if (backdropSamplerKind !== "ipc") return;
  backdropGrabBusy = true;
  void api.dim
    .sampleBackdrop()
    .then((color) => {
      if (dimmed && color) feedBackdropSample(color);
    })
    .catch(() => undefined)
    .finally(() => {
      backdropGrabBusy = false;
    });
}

/** Re-samples once the window has stopped moving (one grab per move, not per pixel). */
function scheduleBackdropSampleAfterMove(): void {
  if (backdropSamplerKind !== "ipc") return;
  if (backdropSettleTimer !== null) window.clearTimeout(backdropSettleTimer);
  backdropSettleTimer = window.setTimeout(() => {
    backdropSettleTimer = null;
    requestBackdropSample();
  }, BACKDROP_AFTER_MOVE_MS);
}

/**
 * Fallback sampler: asks the main process for the colour behind the overlay via a
 * small screen grab. Used whenever there is no screen-share video track — before
 * Start and in Phone mode — so the adaptive dim never depends on capture being live.
 * Event-driven, not polled: see BACKDROP_IPC_HEARTBEAT_MS for why.
 */
function createIpcBackdropSampler(): { stop: () => void } {
  // One grab now so the tone is right immediately, then only a slow heartbeat —
  // moves are handled by scheduleBackdropSampleAfterMove().
  const kick = window.setTimeout(() => requestBackdropSample(), 0);
  const heartbeat = window.setInterval(() => requestBackdropSample(), BACKDROP_IPC_HEARTBEAT_MS);

  return {
    stop: () => {
      window.clearTimeout(kick);
      window.clearInterval(heartbeat);
      if (backdropSettleTimer !== null) {
        window.clearTimeout(backdropSettleTimer);
        backdropSettleTimer = null;
      }
      backdropColor = null;
      clearBackdropTone();
    },
  };
}

/**
 * Samples the screen under the overlay once a second from the live display stream.
 * Only runs while dimmed; system-audio mode only (Phone mode has no video track).
 */
function createBackdropSampler(stream: MediaStream): { stop: () => void } {
  const video = document.createElement("video");
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  void video.play().catch(() => undefined);

  const canvas = document.createElement("canvas");
  canvas.width = 24;
  canvas.height = 24;
  const context = canvas.getContext("2d", { willReadFrequently: true });

  const intervalId = window.setInterval(() => {
    if (!dimmed || !context || video.readyState < 2) return;
    const frameWidth = video.videoWidth;
    const frameHeight = video.videoHeight;
    if (frameWidth === 0 || frameHeight === 0) return;

    // Map the overlay's on-screen rect into the captured frame's pixels.
    const scaleX = frameWidth / window.screen.width;
    const scaleY = frameHeight / window.screen.height;
    const sx = clamp(window.screenX * scaleX, 0, frameWidth - 1);
    const sy = clamp(window.screenY * scaleY, 0, frameHeight - 1);
    const sw = clamp(window.outerWidth * scaleX, 1, frameWidth - sx);
    const sh = clamp(window.outerHeight * scaleY, 1, frameHeight - sy);

    try {
      context.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    } catch {
      return; // Frame not decodable yet.
    }
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let red = 0;
    let green = 0;
    let blue = 0;
    for (let i = 0; i < data.length; i += 4) {
      red += data[i] ?? 0;
      green += data[i + 1] ?? 0;
      blue += data[i + 2] ?? 0;
    }
    const pixels = data.length / 4;
    feedBackdropSample({ r: red / pixels, g: green / pixels, b: blue / pixels });
  }, BACKDROP_SAMPLE_MS);

  return {
    stop: () => {
      window.clearInterval(intervalId);
      video.srcObject = null;
      backdropColor = null;
      clearBackdropTone();
    },
  };
}

/**
 * Nudges the dim faintness (Ctrl+Shift+Up = fainter, Ctrl+Shift+Down = clearer),
 * repaints immediately from the last measurement, and persists the choice.
 */
function adjustDimDelta(step: number): void {
  // Snap to the nearest level first, so a saved in-between value still steps cleanly.
  let index = 0;
  let closest = Infinity;
  DIM_LEVELS.forEach((value, i) => {
    const distance = Math.abs(value - dimTextDelta);
    if (distance < closest) {
      closest = distance;
      index = i;
    }
  });
  const nextIndex = clamp(index + step, 0, DIM_LEVELS.length - 1);
  const next = clamp(DIM_LEVELS[nextIndex] ?? dimTextDelta, DIM_DELTA_MIN, DIM_DELTA_MAX);
  if (next === dimTextDelta) return;

  dimTextDelta = next;
  void api.dim.setDelta(next).catch(() => undefined);
  if (backdropColor !== null) applyBackdropTone(backdropColor, true);
  appendLog(
    "Dim",
    `faintness level ${nextIndex + 1}/${DIM_LEVELS.length} (gap ${next}, ${
      step < 0 ? "fainter" : "clearer"
    })`,
  );
}

/** Starts/stops backdrop sampling to match the current dim + capture state. */
/**
 * Keeps exactly one backdrop sampler running while dimmed, preferring the live
 * screen-share video (free — we already hold the track) and falling back to a small
 * screen grab via main when there isn't one. Restarts on source changes so pressing
 * Start/Stop mid-dim swaps cleanly.
 */
function syncBackdropSampler(): void {
  const displayStream = capture?.displayStream ?? null;
  const wanted = !dimmed ? "none" : displayStream ? "video" : "ipc";

  if (backdropSamplerKind !== wanted) {
    backdropSampler?.stop();
    backdropSampler = null;
    backdropSamplerKind = "none";

    if (wanted === "video" && displayStream) {
      backdropSampler = createBackdropSampler(displayStream);
      backdropSamplerKind = "video";
      appendLog("Dim", "adaptive sampling started (screen-share video)");
    } else if (wanted === "ipc") {
      backdropSampler = createIpcBackdropSampler();
      backdropSamplerKind = "ipc";
      appendLog("Dim", "adaptive sampling started (screen grab)");
    } else {
      appendLog("Dim", "adaptive sampling stopped");
    }
  }
}

/** Toggles (or sets) the overlay's privacy dim. */
function setDim(next?: boolean): void {
  dimmed = next ?? !dimmed;
  if (overlayEl instanceof HTMLElement) {
    if (dimmed) {
      overlayEl.dataset.dim = "on";
    } else {
      delete overlayEl.dataset.dim;
    }
  }
  const button = asButton(dimBtn);
  if (button) {
    button.textContent = dimmed ? "Dimmed" : "Dim";
    button.dataset.active = String(dimmed);
    button.setAttribute("aria-pressed", String(dimmed));
  }
  if (!dimmed) clearBackdropTone();
  syncBackdropSampler();
  // Collapse the window to the compact bar (or restore it) to match the CSS layout.
  void api.dim.setCompact(dimmed).catch(() => undefined);
  // The visible area just changed size — keep the latest answer text in view.
  requestAnimationFrame(() => {
    if (answerTextEl) answerTextEl.scrollTop = answerTextEl.scrollHeight;
  });
  appendLog("Overlay", dimmed ? "privacy dim ON (compact)" : "privacy dim off");
}

/** Toggles (or sets) the frozen state of the answer box and updates the lock button. */
function setLocked(next?: boolean): void {
  locked = next ?? !locked;
  const button = asButton(lockBtn);
  if (button) {
    // Plain text, no emoji: emoji render as colour glyphs that ignore CSS `color`,
    // so they stayed fully bright while the rest of the overlay dimmed.
    button.textContent = locked ? "Locked" : "Lock";
    button.setAttribute("aria-pressed", String(locked));
    button.dataset.active = String(locked);
  }
  if (answerTextEl) answerTextEl.dataset.locked = String(locked);
  appendLog("Overlay", locked ? "answer LOCKED (frozen)" : "answer unlocked");
}

/** Matches keyword-led declarations (class/struct/def/function…) across languages. */
const DECL_LINE_RE =
  /^\s*(?:(?:export|public|private|protected|static|final|abstract|async|virtual|override|inline|template)\s+)*(?:func|function|def|fn|class|struct|interface|enum)\b/;
/**
 * Matches a function/method DEFINITION header — e.g. C++ "int maxProfit(vector<int>& p) {",
 * "TreeNode* solve(TreeNode* root) const {", or Java "public int solve(int n) {". Requires a
 * return-type token + name + (params) and an opening "{", and excludes control-flow keywords
 * (if/for/while/…) so statements and calls aren't bolded.
 */
const FUNC_DEF_RE =
  /^\s*(?!(?:if|for|while|switch|else|catch|do|return|throw|case|sizeof)\b)(?:[A-Za-z_][\w:<>,.&*]*\s+)+[&*]?[A-Za-z_]\w*\s*\([^;{}]*\)\s*(?:const|noexcept|override|final|mutable)*\s*\{\s*$/;

/**
 * Renders a code answer as HTML: escapes it, drops any stray [[B]] markers, and
 * bolds the function/class/struct/method declaration lines so the signatures the
 * interviewer wants stand out from the body.
 */
function renderCodeHtml(raw: string): string {
  const cleaned = raw.replace(/\[\[\/?B\]\]/g, "");
  return cleaned
    .split("\n")
    .map((line) => {
      const escaped = line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return DECL_LINE_RE.test(line) || FUNC_DEF_RE.test(line)
        ? `<strong>${escaped}</strong>`
        : escaped;
    })
    .join("\n");
}

/**
 * Marks a spoken answer that actually contains code (SQL, pandas, a function) so it
 * can be shown in monospace. Deliberately requires a real multi-keyword construct —
 * merely saying the word "select" in prose must not flip the whole answer to code.
 */
const SPOKEN_CODE_RE =
  /(\bSELECT\b[\s\S]{0,400}?\bFROM\b|\bWITH\b[\s\S]{0,200}?\bAS\s*\(|\bdef\s+\w+\s*\(|\bfunction\s+\w+\s*\(|\bGROUP\s+BY\b|\bJOIN\b[\s\S]{0,120}?\bON\b)/i;

/** Pending answer-render frame, so a burst of deltas paints at most once per frame. */
let answerRafId: number | null = null;

/** Drops any scheduled answer paint (used when the box is set to a static string). */
function cancelScheduledAnswerRender(): void {
  if (answerRafId !== null) {
    window.cancelAnimationFrame(answerRafId);
    answerRafId = null;
  }
}

/**
 * Paints the active buffer into the answer box. Called once per animation frame at
 * most: re-rendering the whole buffer per streamed token is O(n²) DOM work (worst in
 * code mode, where every delta re-runs renderCodeHtml + an innerHTML reparse).
 */
function renderAnswerNow(): void {
  if (!answerTextEl) return;
  const distanceFromBottom =
    answerTextEl.scrollHeight - answerTextEl.scrollTop - answerTextEl.clientHeight;
  const wasNearBottom = distanceFromBottom < 48;

  if (answerMode === "code") {
    answerTextEl.innerHTML = renderCodeHtml(codeBuffer);
  } else {
    answerTextEl.textContent = proseBuffer;
    // A spoken answer can legitimately contain code — "write me a SQL query for..."
    // is asked out loud all the time. Switch to monospace when it does, so the
    // keywords and indentation line up the way they will in the editor.
    answerTextEl.dataset.mono = SPOKEN_CODE_RE.test(proseBuffer) ? "true" : "";
  }

  if (wasNearBottom) answerTextEl.scrollTop = answerTextEl.scrollHeight;
}

function scheduleAnswerRender(): void {
  if (answerRafId !== null) return;
  answerRafId = window.requestAnimationFrame(() => {
    answerRafId = null;
    renderAnswerNow();
  });
}

/** Sets the answer box to a single static string (intro, blank, errors). Resets buffers. */
function setAnswer(text: string, state: "" | "pending" | "error" = ""): void {
  if (!answerTextEl) return;
  cancelScheduledAnswerRender();
  answerMode = "prose";
  proseBuffer = text;
  codeBuffer = "";
  startNewProseBlock = false;
  answerTextEl.textContent = text;
  answerTextEl.dataset.state = state;
  answerTextEl.dataset.mode = "";
  answerTextEl.scrollTop = 0;
}

/** Streams one delta into the active buffer and schedules a per-frame paint. */
function streamDelta(text: string): void {
  if (!answerTextEl || locked) return;

  if (answerMode === "code") {
    // First delta clears the "Reading your screen…" placeholder.
    if (answerTextEl.dataset.state) {
      answerTextEl.dataset.state = "";
      codeBuffer = "";
    }
    codeBuffer += text;
  } else {
    // Prose: start a new block (with a separator) on the first delta after an ask,
    // so the previous answer stays visible above it.
    if (startNewProseBlock) {
      if (proseBuffer.trim().length > 0) {
        // Keep only the most recent (maxProseAnswers - 1) blocks, then start a new one,
        // so the box never grows past maxProseAnswers answers.
        const recent = proseBuffer.split(PROSE_SEPARATOR).slice(-(maxProseAnswers - 1));
        proseBuffer = recent.join(PROSE_SEPARATOR) + PROSE_SEPARATOR;
      }
      startNewProseBlock = false;
      answerTextEl.dataset.state = "";
    }
    proseBuffer += text;
  }

  scheduleAnswerRender();
}

/** Set when an ask fires; cleared on the first delta to log fire->first-token latency. */
let askStartedAt = 0;

async function runAsk(): Promise<void> {
  if (locked) return;
  if (isAsking) {
    // A new question arrived while an answer is still streaming: queue exactly one
    // follow-up ask instead of silently dropping it.
    pendingAsk = true;
    appendLog("Overlay", "ask queued (answer still streaming)");
    return;
  }
  isAsking = true;
  const button = asButton(askBtn);
  if (button) button.disabled = true;
  // Keep the previous answer visible (no "Thinking…" wipe); the next delta starts a
  // fresh block below it, so a counter-question's answer appears without a blank gap.
  answerMode = "prose";
  if (answerTextEl) {
    answerTextEl.dataset.mode = "";
    answerTextEl.dataset.state = "";
  }
  startNewProseBlock = true;
  askStartedAt = performance.now();

  // try/finally: if the IPC call REJECTS rather than returning an error object (main
  // process hung, crashed, or a serialisation fault), the busy flag would otherwise
  // stay set forever and every later ask/code/explain would silently do nothing —
  // an app that looks alive but answers nothing, with a restart the only way out.
  try {
    const result = await api.infer.run(transcriptContext.slice(-maxInferLines));
    if (!result.ok && result.error && result.error !== "cancelled") {
      setAnswer(result.error, "error");
    }
  } catch (err) {
    setAnswer(`Answer failed: ${getErrorMessage(err)}`, "error");
  } finally {
    isAsking = false;
    if (button) button.disabled = false;
    // Remember what was put on screen so that, in Phone mode, hearing the user read it
    // back is recognised as their own voice rather than a new question.
    noteAnswerShown(proseBuffer);
  }

  // Answer a question that fired mid-stream, now that the transcript includes it.
  if (pendingAsk && !locked) {
    pendingAsk = false;
    void runAsk();
  }
}

/**
 * Coding mode: the main process screenshots the screen, sends it to Groq's
 * vision model, and streams an approach + solution back via the same answer
 * channel. Rendered in monospace so code/indentation stays readable.
 */
async function runCoding(): Promise<void> {
  if (isAsking || locked) return;
  // An explicit mode switch supersedes any queued auto-ask (it would clobber the code).
  pendingAsk = false;
  isAsking = true;
  const ask = asButton(askBtn);
  const solve = asButton(solveBtn);
  if (ask) ask.disabled = true;
  if (solve) solve.disabled = true;
  // Code mode: monospace + bold rendering, and a fresh buffer for this solution.
  answerMode = "code";
  codeBuffer = "";
  if (answerTextEl) {
    answerTextEl.dataset.mode = "code";
    answerTextEl.dataset.state = "pending";
    answerTextEl.textContent = "Reading your screen…";
  }
  askStartedAt = performance.now();

  // Send recent transcript so a verbally-modified coding question is understood.
  // try/finally so a rejected IPC call can never leave the busy flag stuck (see runAsk).
  try {
    const result = await api.coding.run(transcriptContext.slice(-maxInferLines));
    if (!result.ok && result.error && result.error !== "cancelled") {
      setAnswer(result.error, "error");
    }
  } catch (err) {
    setAnswer(`Coding mode failed: ${getErrorMessage(err)}`, "error");
  } finally {
    isAsking = false;
    if (ask) ask.disabled = false;
    if (solve) solve.disabled = false;
  }
}

/**
 * Converts the last coding solution into language-agnostic pseudo code — for when
 * the interviewer says "now write the pseudo code of that approach". No new capture.
 */
async function runPseudocode(): Promise<void> {
  if (isAsking || locked) return;
  pendingAsk = false;
  isAsking = true;
  const ask = asButton(askBtn);
  const solve = asButton(solveBtn);
  const pseudo = asButton(pseudoBtn);
  if (ask) ask.disabled = true;
  if (solve) solve.disabled = true;
  if (pseudo) pseudo.disabled = true;
  answerMode = "code";
  codeBuffer = "";
  if (answerTextEl) {
    answerTextEl.dataset.mode = "code";
    answerTextEl.dataset.state = "pending";
    answerTextEl.textContent = "Writing pseudo code…";
  }
  askStartedAt = performance.now();

  // try/finally so a rejected IPC call can never leave the busy flag stuck (see runAsk).
  try {
    const result = await api.pseudocode.run();
    if (!result.ok) {
      if (result.error === "no-code") {
        setAnswer(
          "Press Ctrl+Shift+C to solve a problem first — then I can give its pseudo code.",
          "",
        );
      } else if (result.error && result.error !== "cancelled") {
        setAnswer(result.error, "error");
      }
    }
  } catch (err) {
    setAnswer(`Pseudocode failed: ${getErrorMessage(err)}`, "error");
  } finally {
    isAsking = false;
    if (ask) ask.disabled = false;
    if (solve) solve.disabled = false;
    if (pseudo) pseudo.disabled = false;
  }
}

/**
 * Explains the on-screen code's logic as cue bullets — for "walk me through your
 * code" / "explain line 40". Screenshots the screen and uses the session memory.
 */
async function runExplain(): Promise<void> {
  if (isAsking || locked) return;
  pendingAsk = false;
  isAsking = true;
  const ask = asButton(askBtn);
  const solve = asButton(solveBtn);
  if (ask) ask.disabled = true;
  if (solve) solve.disabled = true;
  answerMode = "prose";
  proseBuffer = "";
  startNewProseBlock = false;
  if (answerTextEl) {
    answerTextEl.dataset.mode = "";
    answerTextEl.dataset.state = "";
    answerTextEl.textContent = "Explaining your code…";
  }
  askStartedAt = performance.now();

  // try/finally so a rejected IPC call can never leave the busy flag stuck (see runAsk).
  try {
    const result = await api.explain.run(transcriptContext.slice(-maxInferLines));
    if (!result.ok && result.error && result.error !== "cancelled") {
      setAnswer(result.error, "error");
    }
  } catch (err) {
    setAnswer(`Explain failed: ${getErrorMessage(err)}`, "error");
  } finally {
    isAsking = false;
    if (ask) ask.disabled = false;
    if (solve) solve.disabled = false;
  }
}

/**
 * Quick ask: treat a typed question exactly like one the interviewer just spoke —
 * append it to the transcript context and run the normal ask. That reuses the whole
 * pipeline (pinned solutions, persona, role, provider failover) instead of building
 * a parallel path, so a typed follow-up about your code works the same as a spoken one.
 */
function submitQuickAsk(): void {
  const input = quickAskInput instanceof HTMLInputElement ? quickAskInput : null;
  const question = input?.value.trim() ?? "";
  if (!question) return;
  if (locked) {
    appendLog("Quick ask", "ignored — the answer box is locked");
    return;
  }

  transcriptContext.push({ speaker: "them", text: question });
  if (transcriptContext.length > maxContextLines) {
    transcriptContext.splice(0, transcriptContext.length - maxContextLines);
  }
  // Show it in the transcript so it is visible where it came from, and record it for
  // the notes export — a typed question is usually one the mic missed.
  if (transcriptLinesEl) {
    const line = document.createElement("div");
    line.className = "transcript-line transcript-line-final";
    setTranscriptLineText(line, question);
    transcriptLinesEl.appendChild(line);
    pruneTranscriptLines();
    transcriptLinesEl.scrollTop = transcriptLinesEl.scrollHeight;
  }
  recordQuestion(question);
  api.transcript.line("them", question);

  if (input) input.value = "";
  appendLog("Quick ask", question);
  void runAsk();
}

/** The user's fixed opening introduction, shown verbatim the moment capture starts. */
const FIXED_INTRO =
  "Thanks for having me. I'm Dev, an AI Engineer with about two and a half years of " +
  "experience building LLM, RAG and automation systems, after a B.Tech in Computer Science " +
  "with Data Science at VIT. At BeyondData Solutions I built OCR and NLP pipelines on Oracle " +
  "Cloud that cut manual document processing by over 50%. At Appstane Technologies I build " +
  "RAG systems and GenAI apps, like chatbots, that improved automation efficiency by over " +
  "40%. Turning manual processes into reliable AI workflows is exactly what I enjoy, which " +
  "is why this role excites me.";

/** Shows the user's fixed introduction in the answer box the moment capture starts. */
function showIntro(): void {
  setAnswer(FIXED_INTRO);
}

function pruneTranscriptLines(): void {
  if (!transcriptLinesEl) return;

  while (transcriptLinesEl.children.length > maxTranscriptLines) {
    const removed = transcriptLinesEl.firstElementChild;
    removed?.remove();
    for (const [side, line] of partialTranscriptLines) {
      if (line === removed) {
        partialTranscriptLines.delete(side);
      }
    }
  }
}

function handleTranscript(event: SttTranscriptEvent): void {
  const transcript = event.transcript.trim();
  if (!transcript || !transcriptLinesEl) return;
  // System-audio-only: everything we transcribe is "them".
  if (event.speaker !== "them") return;

  if (event.isFinal) {
    const partialLine = partialTranscriptLines.get("Them");
    if (partialLine) {
      partialLine.remove();
      partialTranscriptLines.delete("Them");
    }

    const line = document.createElement("div");
    line.className = "transcript-line transcript-line-final";
    setTranscriptLineText(line, transcript);
    transcriptLinesEl.appendChild(line);

    transcriptContext.push({ speaker: "them", text: transcript });
    if (transcriptContext.length > maxContextLines) {
      transcriptContext.splice(0, transcriptContext.length - maxContextLines);
    }
  } else {
    let line = partialTranscriptLines.get("Them");
    if (!line) {
      line = document.createElement("div");
      line.className = "transcript-line transcript-line-partial";
      partialTranscriptLines.set("Them", line);
      transcriptLinesEl.appendChild(line);
    }
    setTranscriptLineText(line, transcript);
  }

  pruneTranscriptLines();
  transcriptLinesEl.scrollTop = transcriptLinesEl.scrollHeight;
}

/**
 * Builds a silent audio MediaStream for channel 0 ("You"). Keeps the 2-channel
 * layout intact (so the meeting audio stays on channel 1 = "them") without ever
 * touching the real microphone.
 */
function createSilentMicStream(): { stream: MediaStream; context: AudioContext } {
  const context = new AudioContext();
  const destination = context.createMediaStreamDestination();
  const source = context.createConstantSource();
  source.offset.value = 0;
  source.connect(destination);
  source.start();
  return { stream: destination.stream, context };
}

function stopStreams(streams: Array<MediaStream | null>): void {
  const tracks = new Set<MediaStreamTrack>();
  for (const stream of streams) {
    for (const track of stream?.getTracks() ?? []) {
      tracks.add(track);
    }
  }
  for (const track of tracks) {
    track.stop();
  }
}

/** Token/relay suppliers routed through the main process (keys stay there). */
async function getDeepgramToken(): Promise<{ accessToken: string; expiresInSeconds?: number }> {
  const result = await api.stt.token("deepgram");
  if (!result.ok || !result.accessToken) {
    throw new Error(result.error ?? "Deepgram token request failed");
  }
  return { accessToken: result.accessToken, expiresInSeconds: result.expiresInSeconds };
}

async function getElevenLabsToken(): Promise<string> {
  const result = await api.stt.token("elevenlabs");
  if (!result.ok || !result.accessToken) {
    throw new Error(result.error ?? "ElevenLabs token request failed");
  }
  return result.accessToken;
}

async function getSarvamRelayUrl(): Promise<string> {
  const result = await api.stt.sarvamRelay();
  if (!result.ok || !result.url) {
    throw new Error(result.error ?? "Sarvam relay failed to start");
  }
  return result.url;
}

async function startCapture(): Promise<void> {
  if (capture !== null || isStartingCapture) return;

  isStartingCapture = true;
  hideError();
  setCaptureControls();
  updateCaptureStatus("pending", "starting");
  // Show the fixed intro immediately, before Deepgram connects, so it's ready to deliver.
  showIntro();

  let micStream: MediaStream | null = null;
  let displayStream: MediaStream | null = null;
  let systemAudioStream: MediaStream | null = null;
  let auxContext: AudioContext | null = null;
  let monitors: AudioMonitor[] = [];
  let sttAdapter: SpeechToTextAdapter | null = null;
  let sttUnsubscribe: Array<() => void> = [];

  try {
    clearTranscript();
    // A silent channel 0 keeps Deepgram's 2-channel layout (the captured audio stays
    // on channel 1 = "them").
    const silent = createSilentMicStream();
    micStream = silent.stream;
    auxContext = silent.context;

    const phoneMode = sourceDropdown?.getValue() === "phone";
    if (phoneMode) {
      // Phone mode: capture the laptop MICROPHONE — it hears the interviewer through the
      // phone's speaker (put the call on speakerphone near the laptop). Treated as "them".
      appendLog("Capture", "starting PHONE mode (laptop microphone, raw audio)");
      // RAW audio, with every browser enhancement OFF. `{ audio: true }` silently enables
      // echo cancellation, noise suppression and auto gain, and in this mode all three
      // work against us:
      //  - Echo cancellation exists to remove sound arriving from a nearby loudspeaker so
      //    it does not feed back. A phone on speakerphone beside the laptop is exactly
      //    that, so the far end's voice — the ONLY voice we need — gets cancelled while
      //    the user's own voice, arriving directly, passes through untouched.
      //  - Noise suppression treats band-limited, compressed phone-call audio as noise.
      //  - Auto gain rides the level up during silence, amplifying room noise into the
      //    transcript between turns.
      // Verified symptom before this change: the other party was inaudible to the app
      // while the user's own speech transcribed normally.
      systemAudioStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      const micTrack = systemAudioStream.getAudioTracks()[0];
      if (micTrack) {
        // Log what the browser actually granted — constraints are requests, not promises,
        // and a driver-level effect can re-enable processing behind our back.
        const s = micTrack.getSettings() as MediaTrackSettings & {
          echoCancellation?: boolean;
          noiseSuppression?: boolean;
          autoGainControl?: boolean;
        };
        appendLog(
          "Mic",
          `${micTrack.label} | echoCancel=${s.echoCancellation} noiseSup=${s.noiseSuppression} agc=${s.autoGainControl}`,
        );
      }
    } else {
      // System mode: capture this PC's meeting audio via loopback; the mic is never opened.
      appendLog("Capture", "starting system loopback (microphone never used)");
      displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      systemAudioStream = new MediaStream(requireAudioTracks(displayStream));
    }
    logStreamReady(systemAudioStream);

    monitors = [createAudioMonitor(systemAudioStream)];

    // Try the selected provider first, then any other provider that has a key. A
    // provider whose servers are unreachable (a slow/blocked path to Deepgram is the
    // common one) must not cost the whole session when another is configured.
    const candidates: SttProvider[] = [
      activeProvider,
      ...STT_PROVIDER_ORDER.filter((p) => p !== activeProvider && availableProviders[p]),
    ];

    let provider = activeProvider;
    let startError: unknown = null;
    for (const [index, candidate] of candidates.entries()) {
      provider = candidate;
      appendLog("STT", `starting ${candidate} live transcription`);
      updateSttStatus("pending", `connecting (${candidate})`);
      const adapter = createSttAdapter(candidate, {
        // Phone mode puts BOTH voices on one microphone, so ask Deepgram who is
        // speaking; system mode already separates them by channel.
        diarize: phoneMode,
        micStream,
        systemAudioStream,
        getDeepgramToken,
        getElevenLabsToken,
        getSarvamRelayUrl,
        onLog: appendLog,
        // Keep the STT pill honest across mid-session drops (adapter reconnects itself).
        onStatus: (status) => {
          if (status === "reconnecting") {
            updateSttStatus("pending", `${candidate} reconnecting…`);
          } else if (status === "live") {
            updateSttStatus("active", `${candidate} live`);
          } else {
            updateSttStatus("error", `${candidate} disconnected`);
            showError(
              "Speech-to-text connection was lost and could not be restored. " +
                "Press Stop, then Start to resume transcription.",
            );
          }
        },
      });
      try {
        await adapter.start();
        sttAdapter = adapter;
        startError = null;
        if (index > 0) {
          appendLog("STT", `${activeProvider} unavailable — switched to ${candidate}`);
          showError(
            `${activeProvider} could not connect, so transcription is running on ` +
              `${candidate} instead. Everything else works normally.`,
          );
        }
        break;
      } catch (err: unknown) {
        startError = err;
        appendLog("STT error", `${candidate} failed to start: ${getErrorMessage(err)}`);
        await adapter.stop().catch(() => undefined);
      }
    }
    if (!sttAdapter) {
      throw startError instanceof Error
        ? startError
        : new Error("No speech-to-text provider could be started.");
    }

    // Semantic turn detection: the gate (heuristic + Groq) decides when a them-utterance
    // is complete; the detector fires runAsk once it settles. Interim results drive
    // the live transcript UI only, never inference.
    const gate = createCompletenessGate({
      classify: (utterance) => api.turn.complete(utterance),
      debug: turnDebug,
      onLog: appendLog,
    });
    const detector = new TurnDetector({
      gate,
      onFire: (utterance) => {
        // A fired turn is a complete question/request — capture it for the notes.
        recordQuestion(utterance);
        void runAsk();
      },
      debug: turnDebug,
      onLog: appendLog,
    });
    turnDetector = detector;

    const unsubscribers: Array<() => void> = [
      sttAdapter.onPartial(handleTranscript),
      sttAdapter.onFinal((event) => {
        // Phone mode: the mic carries the user's voice too, and everything it hears
        // arrives labelled "them". Without this check, reading an answer aloud is
        // transcribed as an interviewer turn, fires the detector, and generates a new
        // answer from the user's own words — a loop that drifts further from the real
        // conversation the longer it runs. Relabel as "you" so the detector (which
        // gates on "them") ignores it, while the transcript still shows who spoke.
        let final = event;
        if (phoneMode && event.speaker === "them") {
          const verdict = classifySpeech(event.transcript, event.diarizedSpeaker);
          if (verdict.isUser) {
            final = { ...event, speaker: "you" };
            if (turnDebug) appendLog("SelfVoice", `ignored own speech (${verdict.reason})`);
          }
        }
        // Persist every finalised line before anything else can go wrong with it.
        // handleTranscript drops non-"them" lines from the UI and a failed answer
        // writes nothing, so this is the only complete record of what was said.
        api.transcript.line(final.speaker === "you" ? "you" : "them", final.transcript);
        handleTranscript(final);
        // Only the "them" channel drives end-of-turn detection.
        if (final.speaker === "them") {
          detector.handleThemFinal(final.transcript, final.speechFinal ?? false);
        }
      }),
    ];
    const unsubscribeTurnSignal = sttAdapter.onTurnSignal?.((signal) => {
      if (signal.speaker === "them" && signal.kind === "utterance_end") {
        detector.handleThemUtteranceEnd(signal.lastWordEnd);
      }
    });
    if (unsubscribeTurnSignal) unsubscribers.push(unsubscribeTurnSignal);
    sttUnsubscribe = unsubscribers;
    // The adapter is already started (the fallback loop above starts it to find one
    // that actually connects), so there is nothing left to await here.
    updateSttStatus("active", `${provider} live`);

    capture = {
      micStream,
      displayStream,
      systemAudioStream,
      monitors,
      sttAdapter,
      sttUnsubscribe,
      auxContext,
    };
    // The display stream now exists: start sampling if the overlay is already dimmed.
    syncBackdropSampler();
    appendLog("Capture", `system loopback and ${provider} STT are live`);
    // Deepgram is connected — clear the intro so the field is blank and ready for answers.
    setAnswer("");
  } catch (err: unknown) {
    const message = getErrorMessage(err);
    appendLog("Capture error", message);
    updateCaptureStatus("error", "error");
    updateSttStatus("error", "error");
    showError(message);
    for (const unsubscribe of sttUnsubscribe) unsubscribe();
    turnDetector?.reset();
    turnDetector = null;
    await sttAdapter?.stop().catch(() => undefined);
    for (const monitor of monitors) monitor.stop();
    stopStreams([micStream, displayStream, systemAudioStream]);
    if (auxContext && auxContext.state !== "closed") {
      void auxContext.close().catch(() => undefined);
    }
  } finally {
    isStartingCapture = false;
    setCaptureControls();
  }
}

function stopCapture(): void {
  if (capture === null) return;

  const currentCapture = capture;
  capture = null;
  // The video track is about to stop; drop the sampler before it goes dead.
  syncBackdropSampler();
  turnDetector?.reset();
  turnDetector = null;
  for (const unsubscribe of currentCapture.sttUnsubscribe) unsubscribe();
  void currentCapture.sttAdapter.stop().catch((err: unknown) => {
    appendLog("STT error", `failed to stop: ${getErrorMessage(err)}`);
  });
  for (const monitor of currentCapture.monitors) monitor.stop();
  stopStreams([
    currentCapture.micStream,
    currentCapture.displayStream,
    currentCapture.systemAudioStream,
  ]);
  if (currentCapture.auxContext && currentCapture.auxContext.state !== "closed") {
    void currentCapture.auxContext.close().catch(() => undefined);
  }
  updateCaptureStatus("idle", "stopped");
  updateSttStatus("idle", "stopped");
  removePartialTranscriptLines();
  appendLog("Capture", "stopped system loopback");
  setCaptureControls();
}

// --- Keys panel -------------------------------------------------------------
// The first launch opens this automatically: three fields, Save, done. Keys are checked
// with each provider before saving, so a bad paste is caught here and not mid-interview.

function keyInput(field: KeyField): HTMLInputElement | null {
  const el = document.getElementById(`key-${field}`);
  return el instanceof HTMLInputElement ? el : null;
}

function setKeyStatus(field: KeyField, text: string, state: "" | "ok" | "warn" | "bad"): void {
  const el = document.getElementById(`key-${field}-status`);
  if (!el) return;
  el.textContent = text;
  el.dataset.state = state;
}

function setKeysMessage(text: string, state: "" | "ok" | "bad" = ""): void {
  if (!keysMessageEl) return;
  keysMessageEl.textContent = text;
  keysMessageEl.dataset.state = state;
}

/** Shows what is already saved, so reopening the panel never looks like keys were lost. */
function renderKeysStatus(status: KeysStatus): void {
  for (const field of KEY_FIELDS) {
    const state = status[field];
    if (state.set) {
      setKeyStatus(field, `Saved ✓ (ends ${state.hint || "…"}) — paste a new one only to replace it`, "ok");
    } else {
      setKeyStatus(field, field === "sarvam" ? "Not set — fine unless you need Gujarati" : "Not set yet", "");
    }
  }
}

function requiredKeysSet(status: KeysStatus): boolean {
  return status.groq.set && status.deepgram.set;
}

async function openKeysPanel(): Promise<void> {
  if (!keysPanelEl) return;
  for (const field of KEY_FIELDS) {
    const input = keyInput(field);
    if (input) input.value = "";
  }
  setKeysMessage("");
  try {
    renderKeysStatus(await api.keys.get());
  } catch (err) {
    setKeysMessage(`Could not read saved keys: ${getErrorMessage(err)}`, "bad");
  }
  keysPanelEl.hidden = false;
  asButton(keysBtn)?.setAttribute("data-active", "true");
  keyInput("groq")?.focus();
}

function closeKeysPanel(): void {
  if (keysPanelEl) keysPanelEl.hidden = true;
  asButton(keysBtn)?.setAttribute("data-active", "false");
}

async function saveKeysFromPanel(): Promise<void> {
  const entries: Partial<Record<KeyField, string>> = {};
  for (const field of KEY_FIELDS) {
    const value = keyInput(field)?.value.trim() ?? "";
    if (value) entries[field] = value;
  }
  if (Object.keys(entries).length === 0) {
    setKeysMessage("Paste at least one key first (Ctrl+V).", "bad");
    return;
  }

  const saveButton = asButton(keysSaveBtn);
  if (saveButton) saveButton.disabled = true;
  setKeysMessage("Checking your keys with each provider…");
  for (const field of Object.keys(entries) as KeyField[]) setKeyStatus(field, "Checking…", "");

  try {
    const { results, status } = await api.keys.save(entries);
    renderKeysStatus(status);
    let anyInvalid = false;
    for (const field of KEY_FIELDS) {
      const result = results[field];
      if (!result) continue;
      const state = result.verdict === "valid" ? "ok" : result.verdict === "unverified" ? "warn" : "bad";
      if (result.verdict === "invalid") anyInvalid = true;
      setKeyStatus(field, result.verdict === "valid" ? `Saved ✓ ${result.message}` : result.message, state);
      // A rejected key stays in its field so it can be corrected; saved ones are cleared.
      const input = keyInput(field);
      if (input && result.verdict !== "invalid") input.value = "";
    }

    // Providers and the answer chain read keys at call time, but the dropdowns and the
    // "missing key" banner were built at startup — rebuild them from the new config.
    await initConfig();
    if (!anyInvalid && requiredKeysSet(status)) {
      hideError();
      setKeysMessage("All set. Press Start when your meeting begins.", "ok");
      window.setTimeout(() => {
        if (requiredKeysSet(status)) closeKeysPanel();
      }, 1400);
    } else if (anyInvalid) {
      setKeysMessage("Fix the key marked in red, then Save again.", "bad");
    } else {
      setKeysMessage("Saved. The Groq and Deepgram keys are both needed before you Start.", "");
    }
  } catch (err) {
    setKeysMessage(`Saving failed: ${getErrorMessage(err)}`, "bad");
  } finally {
    if (saveButton) saveButton.disabled = false;
  }
}

/** Opens the panel on launch when a required key is missing — the first-run setup. */
async function promptForMissingKeys(): Promise<void> {
  try {
    if (!requiredKeysSet(await api.keys.get())) await openKeysPanel();
  } catch (err) {
    appendLog("Keys", `status check failed: ${getErrorMessage(err)}`);
  }
}

/** Loads config from main: active provider, key availability, debug flag. */
async function initConfig(): Promise<void> {
  try {
    const config = await api.config.get();
    turnDebug = config.turnDebug;
    activeProvider = config.sttProvider;
    availableProviders = config.availableProviders;
    if (Number.isFinite(config.dimDelta)) {
      dimTextDelta = clamp(config.dimDelta, DIM_DELTA_MIN, DIM_DELTA_MAX);
    }

    if (sttDropdown) {
      // Deepgram and Sarvam are always listed (Sarvam's "(no key)" says what Gujarati
      // needs); any other provider only appears once it has a key.
      sttDropdown.setOptions(
        Object.entries(config.availableProviders)
          .filter(([provider, available]) => available || provider === "deepgram" || provider === "sarvam")
          .map(([provider, available]) => ({
            value: provider,
            label:
              (provider === "sarvam" ? "sarvam (Gujarati)" : provider) + (available ? "" : " (no key)"),
            disabled: !available,
          })),
      );
      sttDropdown.setValue(activeProvider);
      sttDropdown.onChange((value) => {
        void api.config.setSttProvider(value as SttProvider).then((updated) => {
          activeProvider = updated.sttProvider;
          sttDropdown.setValue(updated.sttProvider);
          updateSttStatus("idle", `idle (${updated.sttProvider})`);
        });
      });
    }

    // Which AI writes the answers. Picking one moves it to the front of the chain;
    // the rest stay behind it as automatic fallbacks, so this never removes safety.
    if (answerDropdown) {
      const labels: Record<string, string> = {
        auto: "Auto",
        groq: "Groq",
        mistral: "Mistral",
        gemini: "Gemini",
      };
      // Only providers that have a key: "Mistral (no key)" is noise when nothing uses it.
      answerDropdown.setOptions(
        Object.entries(config.availableAnswerProviders)
          .filter(([, available]) => available)
          .map(([name]) => ({ value: name, label: labels[name] ?? name })),
      );
      answerDropdown.setValue(config.answerProvider);
      answerDropdown.onChange((choice) => {
        void api.config
          .setAnswerProvider(choice as never)
          .then((updated) => {
            answerDropdown.setValue(updated.answerProvider);
            appendLog("Answer AI", `${updated.answerProvider} (others remain as fallbacks)`);
          })
          .catch((err: unknown) => appendLog("Answer AI", `failed: ${getErrorMessage(err)}`));
      });
    }

    if (!config.groqReady) {
      showError("The Groq key is missing, so answers will not work. Click Keys to add it.");
    }
    updateSttStatus("idle", `idle (${activeProvider})`);
  } catch (err) {
    appendLog("Config", `failed to load: ${getErrorMessage(err)}`);
  }
}

if (labelEl) {
  labelEl.textContent = api.appName;
}

api.onLog((entry) => appendLog(entry.label, entry.value));

api.infer.onDelta((text) => {
  if (askStartedAt > 0) {
    appendLog("Latency", `${Math.round(performance.now() - askStartedAt)}ms fire -> first token`);
    askStartedAt = 0;
  }
  streamDelta(text);
});
api.infer.onError((error) => setAnswer(error, "error"));
// Manual override: force an immediate answer, bypassing the turn gate. During capture
// this goes through the detector (so its buffer/state stay consistent); with no capture
// active it falls back to a direct ask on whatever context exists.
api.infer.onHotkey(() => {
  if (turnDetector) {
    turnDetector.forceFire();
  } else {
    void runAsk();
  }
});
// Coding mode: screenshot + solve, via global hotkey (Ctrl+Shift+C) or the button.
api.coding.onHotkey(() => void runCoding());
// Pseudocode of the last solution, via global hotkey (Ctrl+Shift+P) or the button.
api.pseudocode.onHotkey(() => void runPseudocode());
// Explain the on-screen code, via global hotkey (Ctrl+Shift+E).
api.explain.onHotkey(() => void runExplain());
// Lock/unlock the answer box, via global hotkey (Ctrl+Shift+L) or the button.
api.onLockHotkey(() => setLocked());
// Privacy dim cycle, via global hotkey (Ctrl+Shift+D) or the Dim button.
api.onDimHotkey(() => setDim());
// Ctrl+Shift+Up / Down: tune how faint the dimmed overlay is, live.
api.dim.onAdjust((step) => adjustDimDelta(step));
// The window settled somewhere new — re-read the backdrop behind it, exactly once.
api.dim.onWindowMoved(() => scheduleBackdropSampleAfterMove());
dimBtn?.addEventListener("click", () => setDim());
lockBtn?.addEventListener("click", () => setLocked());
askBtn?.addEventListener("click", () => void runAsk());
solveBtn?.addEventListener("click", () => void runCoding());
pseudoBtn?.addEventListener("click", () => void runPseudocode());
startCaptureBtn?.addEventListener("click", () => {
  void startCapture();
});
stopCaptureBtn?.addEventListener("click", () => stopCapture());
clearBtn?.addEventListener("click", () => clearAll());
// Quick ask: Enter (the form's submit) or the arrow button.
quickAskForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  submitQuickAsk();
});
// Global hotkeys are registered in main and would otherwise fire while typing here —
// e.g. Ctrl+Shift+C mid-sentence. Keep plain typing local to the field.
quickAskInput?.addEventListener("keydown", (event) => event.stopPropagation());
notesBtn?.addEventListener("click", () => void openNotes());
keysBtn?.addEventListener("click", () => {
  if (keysPanelEl && !keysPanelEl.hidden) closeKeysPanel();
  else void openKeysPanel();
});
keysCloseBtn?.addEventListener("click", () => closeKeysPanel());
keysFormEl?.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveKeysFromPanel();
});
for (const field of KEY_FIELDS) {
  keyInput(field)?.addEventListener("keydown", (event) => event.stopPropagation());
}
errorDismissBtn?.addEventListener("click", () => hideError());
closeBtn?.addEventListener("click", () => {
  stopCapture();
  api.close();
});
/*
 * Window dragging is NATIVE, via -webkit-app-region in styles.css — not JavaScript.
 *
 * A JS implementation was tried and removed. The CSS drag regions were still active,
 * so the OS moved the window at the same moment the script did: two systems fighting
 * over the same window, which is exactly what made dragging feel heavy and jittery.
 * The native drag is also smoother by construction — the OS owns the move loop and no
 * per-frame IPC is involved at all.
 */

// The right-click menu is drawn by the OS in its OWN window, which Windows content
// protection does not cover — it would be visible in a screen share even though the
// overlay is not. Nothing in the overlay needs it, so block it outright.
window.addEventListener("contextmenu", (event) => event.preventDefault());
window.addEventListener("beforeunload", () => stopCapture());

setCaptureControls();
updateCaptureStatus("idle", "idle");
appendLog("Overlay", "renderer ready");
// Show the fixed intro as soon as the overlay opens; it clears once Deepgram connects.
showIntro();
void initConfig().then(() => promptForMissingKeys());
// (end of renderer bootstrap)
