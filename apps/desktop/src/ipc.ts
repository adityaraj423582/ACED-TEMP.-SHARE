import type {
  InferContextLine,
  InterviewRole,
  SttProvider,
  TurnCompleteResponse,
} from "@aced/shared";

/**
 * IPC contract shared between the Electron main process, the preload bridge, and
 * the renderer. Keeping channel names and payload shapes in one place keeps the
 * three sides in sync.
 */
export const IpcChannel = {
  /** main -> renderer: a status/log entry to display in the overlay. */
  Log: "aced:log",
  /** renderer -> main: user asked to quit the app. */
  Close: "aced:close",
  /** renderer -> main (invoke): read app config (provider, key availability). */
  GetConfig: "aced:config:get",
  /** renderer -> main (invoke): switch the active STT provider. */
  SetSttProvider: "aced:config:set-stt-provider",
  /** renderer -> main (invoke): choose which AI writes the answers. */
  SetAnswerProvider: "aced:config:set-answer-provider",
  /** renderer -> main (invoke): read the saved interview role. */
  GetUserContext: "aced:context:get",
  /** renderer -> main (invoke): save the interview role. */
  SetUserContext: "aced:context:set",
  /** renderer -> main (invoke): mint a short-lived STT credential for a provider. */
  SttToken: "aced:stt:token",
  /** renderer -> main (invoke): start the local Sarvam relay; returns its ws URL. */
  SarvamRelay: "aced:stt:sarvam-relay",
  /** renderer -> main (invoke): run inference on the given labelled context. */
  InferRun: "aced:infer:run",
  /** main -> renderer: a streamed answer text delta. */
  InferDelta: "aced:infer:delta",
  /** main -> renderer: the current answer stream finished. */
  InferDone: "aced:infer:done",
  /** main -> renderer: the answer stream failed. */
  InferError: "aced:infer:error",
  /** main -> renderer: the global "ask" hotkey was pressed. */
  InferHotkey: "aced:infer:hotkey",
  /** renderer -> main (invoke): screenshot the screen and solve the coding question. */
  CodingRun: "aced:coding:run",
  /** main -> renderer: the global "solve code" hotkey was pressed. */
  CodingHotkey: "aced:coding:hotkey",
  /** renderer -> main (invoke): turn the last coding solution into pseudo code. */
  PseudocodeRun: "aced:pseudocode:run",
  /** main -> renderer: the global "pseudocode" hotkey was pressed. */
  PseudocodeHotkey: "aced:pseudocode:hotkey",
  /** renderer -> main (invoke): screenshot + explain the on-screen code's logic. */
  ExplainRun: "aced:explain:run",
  /** main -> renderer: the global "explain code" hotkey was pressed. */
  ExplainHotkey: "aced:explain:hotkey",
  /** main -> renderer: the global "lock/unlock answer" hotkey was pressed. */
  LockHotkey: "aced:lock:hotkey",
  /** main -> renderer: the global "dim" hotkey was pressed (privacy contrast cycle). */
  DimHotkey: "aced:dim:hotkey",
  /** renderer -> main (invoke): classify whether a them-utterance is complete (turn gate). */
  TurnComplete: "aced:turn:complete",
  /** renderer -> main (invoke): forget the remembered coding solution (new problem / Master Clear). */
  ResetMemory: "aced:memory:reset",
  /** renderer -> main (invoke): write the questions-asked notes file and open it. */
  NotesOpen: "aced:notes:open",
  /** renderer -> main (invoke): average screen luminance behind the overlay (adaptive dim). */
  BackdropSample: "aced:dim:sample",
  /** renderer -> main (invoke): shrink the window to the compact dim bar, or restore it. */
  SetCompact: "aced:dim:compact",
  /** main -> renderer: the window finished moving; re-read the backdrop behind it. */
  WindowMoved: "aced:window:moved",
  /** main -> renderer: adjust dim faintness (+1 fainter / -1 clearer) via hotkey. */
  DimAdjust: "aced:dim:adjust",
  /** renderer -> main (invoke): persist the chosen dim faintness. */
  SetDimDelta: "aced:dim:set-delta",
  /**
   * renderer -> main (send): one finalised transcript line, appended to the session
   * transcript file as it arrives. Fire-and-forget rather than invoke: this runs on
   * every final during a live call and must never make the renderer wait on disk.
   */
  TranscriptLine: "aced:transcript:line",
  /** renderer -> main (invoke): which API keys are set (never the keys themselves). */
  KeysGet: "aced:keys:get",
  /** renderer -> main (invoke): check and save API keys entered in the Keys panel. */
  KeysSave: "aced:keys:save",
} as const;

/** The keys the Keys panel edits, as the renderer names them. */
export type KeyField = "groq" | "deepgram" | "sarvam";

/** Whether one key is set, with its last four characters as a hint. */
export interface KeyFieldState {
  set: boolean;
  hint: string;
}

/** What the Keys panel may know about the saved keys. */
export type KeysStatus = Record<KeyField, KeyFieldState>;

/** Outcome of checking and saving one entered key. */
export interface KeyFieldResult {
  /** "valid"/"unverified" keys are saved; "invalid" ones are not. */
  verdict: "valid" | "invalid" | "unverified";
  message: string;
}

/** Result of a Keys panel save: one entry per field that had a value entered. */
export interface KeysSaveResult {
  results: Partial<Record<KeyField, KeyFieldResult>>;
  status: KeysStatus;
}

/** A single labelled line shown in the overlay's status/log area. */
export interface StatusEntry {
  label: string;
  value: string;
}

/**
 * Which AI writes the spoken answers. "auto" keeps the tuned order (Groq first for
 * its ~500ms first token, then Mistral); picking a name just moves it to the front —
 * the others stay behind it as fallbacks, so choosing one never removes the safety net.
 */
export const ANSWER_PROVIDERS = ["auto", "groq", "mistral", "gemini"] as const;

/** Union of the answer-provider choices. */
export type AnswerProviderChoice = (typeof ANSWER_PROVIDERS)[number];

/** Resolves a stored/string value to a known choice, falling back to "auto". */
export function parseAnswerProvider(value: unknown): AnswerProviderChoice {
  return typeof value === "string" && (ANSWER_PROVIDERS as readonly string[]).includes(value)
    ? (value as AnswerProviderChoice)
    : "auto";
}

/** App configuration surfaced to the renderer. */
export interface AppConfig {
  /** Active speech-to-text provider. */
  sttProvider: SttProvider;
  /** Which providers have an API key configured (selectable in the UI). */
  availableProviders: Record<SttProvider, boolean>;
  /** True when the Groq key is present (answers + turn gate). */
  groqReady: boolean;
  /** When true (TURN_DEBUG env), the turn detector + gate log every decision. */
  turnDebug: boolean;
  /** Saved dim faintness (gap between text and backdrop tone); smaller = fainter. */
  dimDelta: number;
  /** Which AI writes the answers; "auto" uses the tuned order. */
  answerProvider: AnswerProviderChoice;
  /** Which answer providers have a key configured (selectable in the UI). */
  availableAnswerProviders: Record<string, boolean>;
}

/**
 * The user's interview context. The resume is baked in permanently (see the
 * shared profile module); the only saved setting is the role to tailor toward.
 */
export interface UserContext {
  /** The role the user is interviewing for (see INTERVIEW_ROLES in @aced/shared). */
  role: InterviewRole;
}

/** Result of an inference run (the answer itself streams via InferDelta events). */
export interface InferRunResult {
  ok: boolean;
  /** Present when ok is false. */
  error?: string;
}

/** Result of minting a short-lived STT credential. */
export interface SttTokenResult {
  ok: boolean;
  accessToken?: string;
  expiresInSeconds?: number;
  /** Present when ok is false. */
  error?: string;
}

/**
 * One completed interviewer turn captured by the turn detector, kept for the
 * meeting-notes export. In System mode this is the interviewer only (the mic is
 * never opened); in Phone mode the mic hears both voices, so both appear.
 */
export interface NotesQuestion {
  /** Local time the question completed (e.g. "10:33:02 AM"). */
  time: string;
  /** The full question/request text. */
  text: string;
}

/** Average colour of the screen area behind the overlay, for the adaptive dim. */
export interface BackdropColor {
  r: number;
  g: number;
  b: number;
}

/** Result of exporting and opening the questions notes file. */
export interface NotesOpenResult {
  ok: boolean;
  /** Absolute path of the written notes file when ok. */
  path?: string;
  /** Present when ok is false. */
  error?: string;
}

/** Result of starting the local Sarvam relay. */
export interface SarvamRelayResult {
  ok: boolean;
  /** ws://127.0.0.1:<port>/stt/sarvam when ok. */
  url?: string;
  /** Present when ok is false. */
  error?: string;
}

/** The API surface exposed to the renderer via contextBridge as `window.aced`. */
export interface AcedApi {
  /** Human-readable app name. */
  readonly appName: string;
  /** Subscribe to status/log entries pushed from the main process. */
  onLog: (handler: (entry: StatusEntry) => void) => void;
  /** Ask the main process to quit the app. */
  close: () => void;
  /** Forget the remembered coding solution (used by Master Clear for a fresh problem). */
  resetMemory: () => void;
  /** App configuration (active provider, key availability). */
  config: {
    get: () => Promise<AppConfig>;
    setSttProvider: (provider: SttProvider) => Promise<AppConfig>;
    /** Choose which AI writes the answers ("auto" = the tuned order). */
    setAnswerProvider: (provider: AnswerProviderChoice) => Promise<AppConfig>;
  };
  /** Persisted interview role (resume is baked in; role tailors the answers). */
  context: {
    get: () => Promise<UserContext>;
    set: (context: UserContext) => Promise<void>;
  };
  /** Speech-to-text credentials routed through main (keys stay out of the renderer). */
  stt: {
    /** Mint a short-lived token for the given provider ("deepgram" | "elevenlabs"). */
    token: (provider: SttProvider) => Promise<SttTokenResult>;
    /** Start (or reuse) the local Sarvam relay and get its WebSocket URL. */
    sarvamRelay: () => Promise<SarvamRelayResult>;
  };
  /** Streaming inference backed by the main process (direct Groq call). */
  infer: {
    /** Run inference on the labelled context. Answer streams via onDelta. */
    run: (context: InferContextLine[]) => Promise<InferRunResult>;
    /** Subscribe to streamed answer text deltas. */
    onDelta: (handler: (text: string) => void) => void;
    /** Subscribe to the end-of-answer signal. */
    onDone: (handler: () => void) => void;
    /** Subscribe to inference errors. */
    onError: (handler: (error: string) => void) => void;
    /** Subscribe to the global "ask" hotkey being pressed. */
    onHotkey: (handler: () => void) => void;
  };
  /** Subscribe to the global "lock/unlock answer" hotkey (Ctrl+Shift+L) being pressed. */
  onLockHotkey: (handler: () => void) => void;
  /** Subscribe to the global "dim" hotkey (Ctrl+Shift+D): cycles overlay contrast. */
  onDimHotkey: (handler: () => void) => void;
  /** Adaptive privacy dim. */
  dim: {
    /**
     * Average colour of the screen area behind the overlay, or null when it can't be
     * measured. Colour, not just brightness: the dim has to match the background's hue
     * as well, or a neutral-grey overlay stands out over anything colourful.
     */
    sampleBackdrop: () => Promise<BackdropColor | null>;
    /**
     * Shrink the window to the compact dim bar (answer + Dim button only), or restore
     * the previous size and position.
     */
    setCompact: (compact: boolean) => Promise<void>;
    /**
     * Fires after the window has been dragged to a new position. The backdrop behind
     * the overlay has changed, so the adaptive dim re-samples — but only once things
     * settle, because a screen grab blocks the main process for over a second.
     */
    onWindowMoved: (handler: () => void) => void;
    /** Persist the chosen dim faintness so it survives a restart. */
    setDelta: (delta: number) => Promise<void>;
    /** Subscribe to the dim faintness hotkeys; step is +1 (fainter) or -1 (clearer). */
    onAdjust: (handler: (step: number) => void) => void;
  };
  /** Coding mode: screenshot the screen and solve the on-screen question (Groq vision). */
  coding: {
    /**
     * Capture the screen and stream a solution. Pass the recent labelled transcript
     * so a verbally-modified question is understood. Answer streams via infer.onDelta.
     */
    run: (context: InferContextLine[]) => Promise<InferRunResult>;
    /** Subscribe to the global "solve code" hotkey being pressed. */
    onHotkey: (handler: () => void) => void;
  };
  /** Pseudocode: convert the last coding solution into language-agnostic pseudo code. */
  pseudocode: {
    /** Generate pseudo code from the last solution. Streams via infer.onDelta. */
    run: () => Promise<InferRunResult>;
    /** Subscribe to the global "pseudocode" hotkey being pressed. */
    onHotkey: (handler: () => void) => void;
  };
  /** Explain: screenshot the screen and explain the on-screen code's logic. */
  explain: {
    /** Capture + explain the code; pass recent transcript. Streams via infer.onDelta. */
    run: (context: InferContextLine[]) => Promise<InferRunResult>;
    /** Subscribe to the global "explain code" hotkey being pressed. */
    onHotkey: (handler: () => void) => void;
  };
  /**
   * Live transcript persistence. Every finalised line is written to disk as it is
   * spoken, so the full record of a call survives an error, a crash, or simply
   * closing the app without exporting anything.
   */
  transcript: {
    /** Append one finalised line to this session's transcript file. */
    line: (speaker: "you" | "them", text: string) => void;
  };
  /** Meeting notes: everything the interviewer asked this session. */
  notes: {
    /** Writes the questions to a .txt in Documents/Aced and opens it. */
    open: (questions: NotesQuestion[]) => Promise<NotesOpenResult>;
  };
  /** API keys, entered in the overlay's Keys panel and stored encrypted on this PC. */
  keys: {
    /** Which keys are set (plus a 4-character hint) — never the keys themselves. */
    get: () => Promise<KeysStatus>;
    /** Checks each non-empty entry with its provider and saves the ones that work. */
    save: (entries: Partial<Record<KeyField, string>>) => Promise<KeysSaveResult>;
  };
  /** End-of-turn detection helpers backed by the main process (direct Groq call). */
  turn: {
    /**
     * Layer 2 of the completeness gate: is `utterance` a complete question/request?
     * Fails open (complete=true) on timeout/error so the overlay never hangs.
     */
    complete: (utterance: string) => Promise<TurnCompleteResponse>;
  };
}
