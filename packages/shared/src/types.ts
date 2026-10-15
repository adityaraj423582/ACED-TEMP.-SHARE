/**
 * The two audio sources Aced transcribes. "you" is the local microphone;
 * "them" is the captured meeting / system (loopback) audio.
 */
export type SpeakerChannel = "you" | "them";

/** A partial or final transcript emitted by a speech-to-text provider. */
export interface SttTranscriptEvent {
  /** Provider-specific adapter name. Deepgram is the Phase 0 implementation. */
  provider: string;
  /** Logical speaker channel for the transcript. */
  speaker: SpeakerChannel;
  /** Transcript text emitted by the provider. */
  transcript: string;
  /** True when the provider has finalized this transcript segment. */
  isFinal: boolean;
  /**
   * Deepgram only: true when this final segment also carries `speech_final` —
   * Deepgram detected end-of-speech (endpointing silence) right after it. The
   * turn detector treats this as a candidate end-of-turn signal. Undefined for
   * providers that don't surface it; never set on interim (isFinal=false) events.
   */
  speechFinal?: boolean;
  /**
   * Deepgram diarisation label for the dominant speaker in this segment, when
   * diarisation is on. Used in Phone mode, where one microphone carries BOTH the
   * user and the other party, to tell them apart. Absent otherwise.
   */
  diarizedSpeaker?: number;
  /** Provider result start time in seconds when available. */
  startSeconds?: number;
  /** Provider result duration in seconds when available. */
  durationSeconds?: number;
}

/** Callback used by speech-to-text adapters for partial and final transcripts. */
export type SttTranscriptHandler = (event: SttTranscriptEvent) => void;

/** Non-transcript turn signals some providers emit (Deepgram vad_events / utterance_end). */
export type SttTurnSignalKind = "utterance_end" | "speech_started";

/**
 * A non-transcript signal used purely for end-of-turn detection. Carries the
 * channel it belongs to so the turn detector can gate on the "them" channel only.
 */
export interface SttTurnSignalEvent {
  /** Provider-specific adapter name. */
  provider: string;
  /** Which signal this is. */
  kind: SttTurnSignalKind;
  /** Logical speaker channel the signal belongs to. */
  speaker: SpeakerChannel;
  /**
   * For "utterance_end": end time (seconds) of the last finalized word. Deepgram
   * sends -1 when there is no pending utterance (stale/duplicate); callers must
   * ignore those. Absent for "speech_started".
   */
  lastWordEnd?: number;
}

/** Callback used by adapters that surface non-transcript turn signals. */
export type SttTurnSignalHandler = (event: SttTurnSignalEvent) => void;

/**
 * Where a turn-completeness verdict came from, for observability (TURN_DEBUG):
 *   "groq"    — the classifier answered YES/NO.
 *   "parse"   — server got an unparseable answer and failed open to complete.
 *   "error"   — server-side timeout/rate-limit/API error; failed open to complete.
 *   "timeout" — client-side budget exceeded (set by the desktop main process); complete.
 */
export type TurnCompleteSource = "groq" | "parse" | "error" | "timeout";

/** Response from POST /turn/complete (Layer 2 of the end-of-turn gate). */
export interface TurnCompleteResponse {
  /** True when the utterance reads as a complete question/request. */
  complete: boolean;
  /** Provenance of the verdict, for debugging that Layer 2 is actually running. */
  source: TurnCompleteSource;
}

/** One labelled line of meeting transcript sent to the model for inference. */
export interface InferContextLine {
  /** Who spoke: "you" (local mic) or "them" (meeting audio). */
  speaker: SpeakerChannel;
  /** Transcript text for this line. */
  text: string;
}

/** Minimal provider-agnostic speech-to-text adapter contract. */
export interface SpeechToTextAdapter {
  /** Start the provider connection and begin streaming audio. */
  start: () => Promise<void>;
  /** Subscribe to non-final transcript updates. Returns an unsubscribe function. */
  onPartial: (handler: SttTranscriptHandler) => () => void;
  /** Subscribe to final transcript segments. Returns an unsubscribe function. */
  onFinal: (handler: SttTranscriptHandler) => () => void;
  /**
   * Optional: subscribe to non-transcript turn signals (UtteranceEnd, SpeechStarted).
   * Only providers that emit them (Deepgram) implement this. Returns an unsubscribe
   * function. Absent on providers that don't surface turn signals.
   */
  onTurnSignal?: (handler: SttTurnSignalHandler) => () => void;
  /** Stop audio processing and close the provider connection. */
  stop: () => Promise<void>;
}
