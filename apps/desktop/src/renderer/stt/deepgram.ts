import type {
  SpeakerChannel,
  SpeechToTextAdapter,
  SttTranscriptEvent,
  SttTranscriptHandler,
  SttTurnSignalEvent,
  SttTurnSignalHandler,
} from "@aced/shared";

const DEEPGRAM_LISTEN_URL = "wss://api.deepgram.com/v1/listen";
const DEFAULT_TOKEN_ENDPOINT = "http://127.0.0.1:8787/stt-token";
const DEEPGRAM_MODEL = "nova-3";
const TARGET_SAMPLE_RATE = 16000;
const CHANNEL_COUNT = 2;
const FRAMES_PER_CHUNK = 320;
const OPEN_TIMEOUT_MS = 10000;
const KEEP_ALIVE_INTERVAL_MS = 3000;
/** Waits before each reconnect attempt after an unexpected socket drop (last repeats). */
const RECONNECT_DELAYS_MS = [500, 1500, 4000];
/** Total reconnect attempts before declaring the session disconnected. On a flapping
 *  network this keeps trying ~2-3 minutes so capture self-heals when the link returns. */
const MAX_RECONNECT_ATTEMPTS = 10;
/** Initial dial: total attempts before Start gives up (transient blips retry silently). */
const INITIAL_CONNECT_ATTEMPTS = 4;
/** Backoff between initial-dial attempts (last value repeats). */
const INITIAL_RETRY_DELAYS_MS = [400, 1200, 2500];

/**
 * Connection health surfaced to the UI: "reconnecting" while re-dialing after an
 * unexpected drop, "live" once restored, "disconnected" when every attempt failed.
 */
export type SttConnectionStatus = "live" | "reconnecting" | "disconnected";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** A short-lived Deepgram token plus its TTL, however it was obtained. */
export interface DeepgramTokenGrant {
  accessToken: string;
  expiresInSeconds?: number;
}

interface DeepgramSttAdapterOptions {
  /**
   * Ask Deepgram to label speakers. Only useful in Phone mode, where one microphone
   * carries both the user and the other party; in system-audio mode the channels
   * already separate them, so it is left off to keep the payload lean.
   */
  diarize?: boolean;
  micStream: MediaStream;
  systemAudioStream: MediaStream;
  tokenEndpoint?: string;
  /**
   * Supplies the short-lived Deepgram token. When provided (the app routes this
   * through the authed, cap-gated main process), it is used instead of fetching
   * the token endpoint directly.
   */
  getToken?: () => Promise<DeepgramTokenGrant>;
  onLog?: (label: string, value: string) => void;
  /** Notified on connection drops/recoveries so the UI never shows a stale "live". */
  onStatus?: (status: SttConnectionStatus) => void;
}

interface PcmWorkletMessage {
  type: "audio";
  buffer: ArrayBuffer;
  frames: number;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function readString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function readBoolean(record: JsonRecord, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function getTranscript(payload: JsonRecord): string | null {
  const channel = payload.channel;
  if (!isRecord(channel)) return null;

  const alternatives = channel.alternatives;
  if (!Array.isArray(alternatives)) return null;

  const firstAlternative = alternatives[0];
  if (!isRecord(firstAlternative)) return null;

  const transcript = readString(firstAlternative, "transcript")?.trim();
  return transcript ? transcript : null;
}

// Results messages carry the channel in `channel_index` ([index, total]).
/**
 * Dominant diarisation speaker for a segment (diarize=true only).
 *
 * Deepgram labels each WORD, not the segment, so a segment can legitimately span two
 * speakers — most often when one talks over the other. Taking the most frequent label
 * gives the segment's real owner instead of whoever happened to say the first word,
 * which matters because a single interjected word would otherwise mislabel the turn.
 */
function getDiarizedSpeaker(payload: JsonRecord): number | undefined {
  const channel = payload.channel;
  if (!isRecord(channel)) return undefined;
  const alternatives = channel.alternatives;
  if (!Array.isArray(alternatives)) return undefined;
  const first = alternatives[0];
  if (!isRecord(first) || !Array.isArray(first.words)) return undefined;

  const counts = new Map<number, number>();
  for (const word of first.words) {
    if (!isRecord(word)) continue;
    const id = readNumber(word, "speaker");
    if (id === undefined) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  let best: number | undefined;
  let bestCount = 0;
  for (const [id, count] of counts) {
    if (count > bestCount) {
      best = id;
      bestCount = count;
    }
  }
  return best;
}

function getSpeaker(payload: JsonRecord): SpeakerChannel | null {
  const channelIndex = payload.channel_index;
  if (!Array.isArray(channelIndex)) return null;

  const sourceChannel = channelIndex[0];
  if (sourceChannel === 0) return "you";
  if (sourceChannel === 1) return "them";
  return null;
}

// UtteranceEnd / SpeechStarted messages carry the channel in `channel` ([index, total]),
// NOT `channel_index`. Kept as a SEPARATE helper on purpose: getting the index source
// wrong per message type would gate the turn on the wrong speaker. Mapping matches
// getSpeaker: 0 = "you" (mic), 1 = "them" (system audio).
function getSignalSpeaker(payload: JsonRecord): SpeakerChannel | null {
  const channel = payload.channel;
  if (!Array.isArray(channel)) return null;

  const sourceChannel = channel[0];
  if (sourceChannel === 0) return "you";
  if (sourceChannel === 1) return "them";
  return null;
}

function isPcmWorkletMessage(value: unknown): value is PcmWorkletMessage {
  return (
    isRecord(value) &&
    value.type === "audio" &&
    value.buffer instanceof ArrayBuffer &&
    typeof value.frames === "number"
  );
}

function disconnectNode(node: AudioNode | null): void {
  try {
    node?.disconnect();
  } catch {
    // Already disconnected.
  }
}

/** Deepgram Nova-3 streaming implementation for Aced's 2-channel STT contract. */
export class DeepgramSttAdapter implements SpeechToTextAdapter {
  private readonly partialHandlers = new Set<SttTranscriptHandler>();
  private readonly finalHandlers = new Set<SttTranscriptHandler>();
  private readonly turnSignalHandlers = new Set<SttTurnSignalHandler>();

  private audioContext: AudioContext | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private systemSource: MediaStreamAudioSourceNode | null = null;
  private merger: ChannelMergerNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private silentGain: GainNode | null = null;
  private socket: WebSocket | null = null;
  private keepAliveIntervalId: number | null = null;
  private isStarted = false;

  public constructor(private readonly options: DeepgramSttAdapterOptions) {}

  public async start(): Promise<void> {
    if (this.isStarted) return;
    this.isStarted = true;

    try {
      await this.connectWithRetry();
      await this.startAudioGraph();
      this.startKeepAlive();
      this.log(
        "Deepgram",
        `streaming ${DEEPGRAM_MODEL}, ${CHANNEL_COUNT} channels, ${TARGET_SAMPLE_RATE} Hz linear16`,
      );
    } catch (err: unknown) {
      await this.stop();
      throw err;
    }
  }

  public onPartial(handler: SttTranscriptHandler): () => void {
    this.partialHandlers.add(handler);
    return () => this.partialHandlers.delete(handler);
  }

  public onFinal(handler: SttTranscriptHandler): () => void {
    this.finalHandlers.add(handler);
    return () => this.finalHandlers.delete(handler);
  }

  public onTurnSignal(handler: SttTurnSignalHandler): () => void {
    this.turnSignalHandlers.add(handler);
    return () => this.turnSignalHandlers.delete(handler);
  }

  public async stop(): Promise<void> {
    this.isStarted = false;

    if (this.keepAliveIntervalId !== null) {
      window.clearInterval(this.keepAliveIntervalId);
      this.keepAliveIntervalId = null;
    }

    const worklet = this.worklet;
    this.worklet = null;
    if (worklet) {
      worklet.port.onmessage = null;
      worklet.port.close();
      disconnectNode(worklet);
    }

    disconnectNode(this.silentGain);
    disconnectNode(this.merger);
    disconnectNode(this.micSource);
    disconnectNode(this.systemSource);
    this.silentGain = null;
    this.merger = null;
    this.micSource = null;
    this.systemSource = null;

    const audioContext = this.audioContext;
    this.audioContext = null;
    if (audioContext && audioContext.state !== "closed") {
      await audioContext.close();
    }

    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState === WebSocket.OPEN) {
      this.sendJson(socket, { type: "CloseStream" });
      socket.close(1000, "Aced stopped");
    } else if (socket && socket.readyState === WebSocket.CONNECTING) {
      socket.close(1000, "Aced stopped");
    }
  }

  private async fetchAccessToken(): Promise<string> {
    if (this.options.getToken) {
      this.log("Deepgram", "requesting short-lived token via main process");
      const grant = await this.options.getToken();
      this.log(
        "Deepgram",
        `received short-lived token (ttl=${grant.expiresInSeconds ?? "unknown"}s)`,
      );
      return grant.accessToken;
    }

    const endpoint = this.options.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT;
    this.log("Deepgram", `requesting short-lived token from ${endpoint}`);

    const res = await fetch(endpoint, { method: "POST" });
    if (!res.ok) {
      throw new Error(`Deepgram token request failed with HTTP ${res.status}`);
    }

    const payload: unknown = await res.json();
    if (!isRecord(payload)) {
      throw new Error("Deepgram token response was not an object");
    }

    const accessToken = readString(payload, "accessToken") ?? readString(payload, "access_token");
    if (!accessToken) {
      throw new Error("Deepgram token response did not include an access token");
    }

    const ttl =
      readNumber(payload, "expiresInSeconds") ?? readNumber(payload, "expires_in") ?? "unknown";
    this.log("Deepgram", `received short-lived token (ttl=${ttl}s)`);
    return accessToken;
  }

  private async openSocket(accessToken: string): Promise<void> {
    const socket = new WebSocket(this.buildListenUrl(), ["bearer", accessToken]);
    this.socket = socket;
    socket.binaryType = "arraybuffer";

    socket.addEventListener("message", (event: MessageEvent<unknown>) => {
      this.handleSocketMessage(event.data);
    });
    socket.addEventListener("close", (event) => {
      this.log("Deepgram", `WebSocket closed code=${event.code} reason=${event.reason || "none"}`);
    });
    socket.addEventListener("error", () => {
      this.log("Deepgram error", "WebSocket error");
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
          cleanup();
          reject(new Error("Deepgram WebSocket open timed out"));
        }, OPEN_TIMEOUT_MS);

        const cleanup = (): void => {
          window.clearTimeout(timeoutId);
          socket.removeEventListener("open", handleOpen);
          socket.removeEventListener("error", handleError);
          socket.removeEventListener("close", handleClose);
        };
        const handleOpen = (): void => {
          cleanup();
          resolve();
        };
        const handleError = (): void => {
          cleanup();
          reject(new Error("Deepgram WebSocket failed to open"));
        };
        const handleClose = (): void => {
          cleanup();
          reject(new Error("Deepgram WebSocket closed before opening"));
        };

        socket.addEventListener("open", handleOpen);
        socket.addEventListener("error", handleError);
        socket.addEventListener("close", handleClose);
      });
    } catch (err: unknown) {
      if (this.socket === socket) this.socket = null;
      socket.close();
      throw err;
    }

    // Watch for unexpected drops only on sockets that actually opened; attaching
    // earlier would treat a failed initial dial as a drop and reconnect-loop it.
    socket.addEventListener("close", () => this.handleUnexpectedClose(socket));

    this.log("Deepgram", "WebSocket connected");
  }

  /**
   * Initial dial with retries. A token is minted fresh per attempt (30s TTL), so a
   * transient network blip at Start recovers on its own instead of erroring out and
   * making the user press Start again.
   */
  private async connectWithRetry(): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const accessToken = await this.fetchAccessToken();
        await this.openSocket(accessToken);
        return;
      } catch (err: unknown) {
        if (attempt >= INITIAL_CONNECT_ATTEMPTS || !this.isStarted) throw err;
        const delay =
          INITIAL_RETRY_DELAYS_MS[Math.min(attempt, INITIAL_RETRY_DELAYS_MS.length) - 1] ?? 2500;
        this.log(
          "Deepgram",
          `connect attempt ${attempt}/${INITIAL_CONNECT_ATTEMPTS} failed ` +
            `(${getErrorMessage(err)}) — retrying in ${delay}ms`,
        );
        await sleep(delay);
      }
    }
  }

  /**
   * A previously-open socket closed. Intentional stops don't land here (stop() nulls
   * this.socket before closing), so anything else is a mid-session drop: reconnect
   * with backoff instead of leaving the session silently dead on a stale "live" UI.
   */
  private handleUnexpectedClose(socket: WebSocket): void {
    if (!this.isStarted || this.socket !== socket) return;
    this.socket = null;
    this.log("Deepgram", "connection dropped mid-session — reconnecting");
    void this.reconnect();
  }

  /** Re-mints a token and re-dials. The audio graph keeps running throughout; the
   *  worklet resumes sending as soon as the new socket reports OPEN. */
  private async reconnect(): Promise<void> {
    this.options.onStatus?.("reconnecting");
    for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt += 1) {
      const delayMs = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length) - 1];
      await sleep(delayMs ?? 4000);
      if (!this.isStarted) return;
      try {
        const accessToken = await this.fetchAccessToken();
        if (!this.isStarted) return;
        await this.openSocket(accessToken);
        this.log("Deepgram", `reconnected (attempt ${attempt})`);
        this.options.onStatus?.("live");
        return;
      } catch (err: unknown) {
        this.log(
          "Deepgram error",
          `reconnect attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS} failed: ${getErrorMessage(err)}`,
        );
      }
    }
    if (this.isStarted) {
      this.log("Deepgram error", "all reconnect attempts failed — transcription stopped");
      this.options.onStatus?.("disconnected");
    }
  }

  private async startAudioGraph(): Promise<void> {
    const audioContext = new AudioContext();
    this.audioContext = audioContext;

    await audioContext.audioWorklet.addModule(new URL("./pcm-worklet.js", import.meta.url));

    this.micSource = audioContext.createMediaStreamSource(this.options.micStream);
    this.systemSource = audioContext.createMediaStreamSource(this.options.systemAudioStream);
    this.merger = audioContext.createChannelMerger(CHANNEL_COUNT);
    this.worklet = new AudioWorkletNode(audioContext, "pcm-worklet", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: CHANNEL_COUNT,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
      outputChannelCount: [CHANNEL_COUNT],
      processorOptions: {
        channelCount: CHANNEL_COUNT,
        framesPerChunk: FRAMES_PER_CHUNK,
        targetSampleRate: TARGET_SAMPLE_RATE,
      },
    });
    this.silentGain = audioContext.createGain();
    this.silentGain.gain.value = 0;

    this.worklet.port.onmessage = (event: MessageEvent<unknown>) => {
      this.handleWorkletMessage(event.data);
    };
    this.worklet.port.onmessageerror = () => {
      this.log("Deepgram error", "AudioWorklet message error");
    };

    this.micSource.connect(this.merger, 0, 0);
    this.systemSource.connect(this.merger, 0, 1);
    this.merger.connect(this.worklet);
    this.worklet.connect(this.silentGain);
    this.silentGain.connect(audioContext.destination);

    await audioContext.resume();
  }

  private buildListenUrl(): string {
    const url = new URL(DEEPGRAM_LISTEN_URL);
    url.searchParams.set("model", DEEPGRAM_MODEL);
    // Multilingual code-switching: transcribe English + Hindi (and others) in one
    // stream, following the speaker's language switches. Lets the interviewer ask in
    // Hindi while answers still come back in English (enforced in the answer prompt).
    url.searchParams.set("language", "multi");
    url.searchParams.set("encoding", "linear16");
    url.searchParams.set("sample_rate", String(TARGET_SAMPLE_RATE));
    url.searchParams.set("channels", String(CHANNEL_COUNT));
    // Single multichannel socket: ch0 = "you" (mic), ch1 = "them" (system audio).
    // The turn-detection params below apply connection-wide, but Deepgram tags
    // is_final / speech_final / UtteranceEnd events with channel_index, so the
    // turn detector can still gate on the "them" channel only.
    url.searchParams.set("multichannel", "true");
    // interim_results: live (unstable) partials for the transcript UI ONLY.
    // Never use interim results to trigger inference (see handleSocketMessage).
    url.searchParams.set("interim_results", "true");
    url.searchParams.set("punctuate", "true");
    // smart_format: yields "?" and sentence punctuation that the completeness
    // gate (Part C) keys off of.
    url.searchParams.set("smart_format", "true");
    // endpointing: ms of silence before Deepgram marks an interim as speech_final.
    // 150ms lands end-of-speech ~50ms sooner than 200; the settle window + gate still
    // guard against a premature split, so this is a safe cut toward a snappier answer.
    url.searchParams.set("endpointing", "150");
    // utterance_end_ms: silence after which Deepgram emits an UtteranceEnd message
    // (requires interim_results=true) — the fallback end-of-turn signal when
    // speech_final doesn't arrive.
    // DO NOT go below 1000: Deepgram rejects the handshake outright for smaller
    // values, which fails EVERY connection (verified — 700 gives a 100% error rate).
    url.searchParams.set("utterance_end_ms", "1000");
    // vad_events: emit SpeechStarted events for voice-activity awareness.
    url.searchParams.set("vad_events", "true");
    // Phone mode only: one mic carries both voices, so ask Deepgram to label who is
    // speaking. See selfVoice.ts for how the label is mapped to the user.
    if (this.options.diarize) url.searchParams.set("diarize", "true");
    return url.toString();
  }

  private startKeepAlive(): void {
    this.keepAliveIntervalId = window.setInterval(() => {
      const socket = this.socket;
      if (socket?.readyState === WebSocket.OPEN) {
        this.sendJson(socket, { type: "KeepAlive" });
      }
    }, KEEP_ALIVE_INTERVAL_MS);
  }

  private handleWorkletMessage(data: unknown): void {
    if (!isPcmWorkletMessage(data) || data.buffer.byteLength === 0) return;

    const socket = this.socket;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(data.buffer);
    }
  }

  private handleSocketMessage(data: unknown): void {
    if (typeof data !== "string") return;

    let payload: unknown;
    try {
      payload = JSON.parse(data) as unknown;
    } catch (err: unknown) {
      this.log("Deepgram error", `invalid JSON message: ${getErrorMessage(err)}`);
      return;
    }
    if (!isRecord(payload)) return;

    const type = readString(payload, "type");
    if (type === "Metadata") {
      const requestId = readString(payload, "request_id") ?? "unknown";
      this.log("Deepgram", `metadata received request_id=${requestId}`);
      return;
    }
    // UtteranceEnd / SpeechStarted are non-transcript turn signals (vad_events +
    // utterance_end_ms). They are routed to turn-signal handlers, never to the
    // transcript UI, and carry their channel in `channel` (see getSignalSpeaker).
    if (type === "UtteranceEnd") {
      this.handleUtteranceEnd(payload);
      return;
    }
    if (type === "SpeechStarted") {
      this.handleSpeechStarted(payload);
      return;
    }
    if (type !== "Results") return;

    const transcript = getTranscript(payload);
    if (!transcript) return;

    const speaker = getSpeaker(payload);
    if (!speaker) {
      this.log("Deepgram error", "transcript result missing expected channel_index");
      return;
    }

    // is_final=false  -> interim/partial: transcript UI display ONLY, never triggers inference.
    // is_final=true   -> finalized segment: safe input for the turn detector (Part B).
    // speech_final=true (only meaningful on a final) -> Deepgram detected end-of-speech
    //   right after this segment: a candidate end-of-turn signal for the detector.
    const isFinal = readBoolean(payload, "is_final") ?? false;
    const speechFinal = readBoolean(payload, "speech_final") ?? false;
    const event: SttTranscriptEvent = {
      provider: "deepgram",
      speaker,
      transcript,
      isFinal,
      speechFinal: isFinal ? speechFinal : undefined,
      diarizedSpeaker: this.options.diarize ? getDiarizedSpeaker(payload) : undefined,
      startSeconds: readNumber(payload, "start"),
      durationSeconds: readNumber(payload, "duration"),
    };

    this.emitTranscript(event);
  }

  // UtteranceEnd: Deepgram saw utterance_end_ms of silence. last_word_end === -1 means
  // there is no pending utterance (stale/duplicate); we forward the value and let the
  // turn detector ignore it, keeping this adapter a thin signal pass-through.
  private handleUtteranceEnd(payload: JsonRecord): void {
    const speaker = getSignalSpeaker(payload);
    if (!speaker) {
      this.log("Deepgram error", "UtteranceEnd missing expected channel");
      return;
    }
    const signal: SttTurnSignalEvent = {
      provider: "deepgram",
      kind: "utterance_end",
      speaker,
      lastWordEnd: readNumber(payload, "last_word_end"),
    };
    this.emitTurnSignal(signal);
  }

  // SpeechStarted (vad_events): voice activity began on a channel. Forwarded for
  // completeness/awareness; the turn detector does not require it to fire.
  private handleSpeechStarted(payload: JsonRecord): void {
    const speaker = getSignalSpeaker(payload);
    if (!speaker) {
      this.log("Deepgram error", "SpeechStarted missing expected channel");
      return;
    }
    this.emitTurnSignal({ provider: "deepgram", kind: "speech_started", speaker });
  }

  private emitTranscript(event: SttTranscriptEvent): void {
    const handlers = event.isFinal ? this.finalHandlers : this.partialHandlers;
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (err: unknown) {
        this.log("Deepgram handler error", getErrorMessage(err));
      }
    }
  }

  private emitTurnSignal(event: SttTurnSignalEvent): void {
    for (const handler of this.turnSignalHandlers) {
      try {
        handler(event);
      } catch (err: unknown) {
        this.log("Deepgram handler error", getErrorMessage(err));
      }
    }
  }

  private sendJson(socket: WebSocket, payload: JsonRecord): void {
    try {
      socket.send(JSON.stringify(payload));
    } catch (err: unknown) {
      this.log("Deepgram error", `failed to send control message: ${getErrorMessage(err)}`);
    }
  }

  private log(label: string, value: string): void {
    this.options.onLog?.(label, value);
  }
}
