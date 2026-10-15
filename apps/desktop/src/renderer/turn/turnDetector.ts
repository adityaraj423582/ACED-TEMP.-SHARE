/**
 * Them-channel end-of-turn detection (Aced Parts B + D).
 *
 * Decides WHEN the other speaker ("them") has actually finished a question/request
 * so the overlay can fire one inference at the right moment — instead of firing on
 * interim transcripts or short pauses (which answers half a question).
 *
 * This module is deliberately decoupled from the "you" channel and from the network:
 *   - The caller feeds it ONLY them-channel signals (channel gating happens upstream
 *     in the STT adapter / renderer hook).
 *   - The completeness decision is injected as `gate` (see completenessGate.ts).
 *   - The fire action is injected as `onFire`; this module never calls /infer itself.
 *
 * State machine (them channel only):
 *   IDLE -> ACCUMULATING -> CANDIDATE_END -> SETTLING -> FIRE -> IDLE
 *
 * On a candidate end-of-turn the settle timer and the gate run CONCURRENTLY (Part D #1):
 * gate latency is hidden under the settle window we already wait, so the gate budget
 * can be generous without adding perceived latency.
 *
 * Bias: patience. Firing ~800ms late is acceptable; firing early is the bug.
 */

// --- Tunables (all named constants live here) -------------------------------
/** Deepgram endpointing silence (ms) before an interim becomes speech_final. */
export const ENDPOINTING_MS = 200;
/** Deepgram silence (ms) before it emits an UtteranceEnd message. Its documented
 *  minimum is 1000 — lower values make Deepgram reject the connection. */
export const UTTERANCE_END_MS = 1000;
/** Quiet period (ms) after a candidate end before we fire (gate runs concurrently). */
export const SETTLE_MS = 280;
/**
 * Shorter settle window used when the buffer ends with "?" — smart-format STT
 * punctuation marking an explicit question end. The risk of a continuation after
 * a question mark is low, so we trade a little patience for a snappier answer.
 */
export const FAST_SETTLE_MS = 130;
/**
 * Hard cap (ms) from the first candidate-end, after which an UNRESOLVED buffer fires
 * anyway. A buffer the gate has actively called INCOMPLETE is left alone instead — see
 * restartMaxWait.
 */
export const MAX_WAIT_MS = 6000;

/**
 * Buffers shorter than this are treated as INCOMPLETE by the gate's heuristic
 * layer unless they end in "?" — avoids firing on a stray "yeah" / "okay".
 */
export const GATE_MIN_WORDS = 3;

/** Gate verdict on whether the buffered them-utterance is a complete question/request. */
export type GateDecision = "COMPLETE" | "INCOMPLETE";

/**
 * Completeness gate. Resolves to COMPLETE when the utterance reads as a finished
 * question/request. Implemented as a cheap client heuristic with a Groq fallback for
 * the ambiguous middle; injected here so the state machine stays pure. It is expected
 * to be self-bounding (it fails open within its own budget), so the detector waits for
 * it rather than racing it with a second timeout.
 */
export type CompletenessGate = (utterance: string) => Promise<GateDecision>;

type TurnState = "IDLE" | "ACCUMULATING" | "CANDIDATE_END" | "SETTLING";

export interface TurnDetectorOptions {
  /** Decides whether the current buffer is a complete utterance. */
  gate: CompletenessGate;
  /** Called with the full them-utterance when the detector decides to fire. */
  onFire: (utterance: string) => void;
  /** When true, log every state transition + buffer text + gate decision (TURN_DEBUG). */
  debug?: boolean;
  /** Sink for debug logs (e.g. the renderer's appendLog). Only used when debug=true. */
  onLog?: (label: string, value: string) => void;
}

/**
 * End-of-turn detector for the "them" channel. One instance per capture session.
 * All timers use the browser `window` clock (this runs in the renderer).
 */
export class TurnDetector {
  private state: TurnState = "IDLE";
  /** Finalized them segments accumulated since the last fire. Joined to form the utterance. */
  private readonly segments: string[] = [];
  /** True when the most recent appended segment carried speech_final (covers the current buffer). */
  private speechFinalSeen = false;
  private settleTimer: number | null = null;
  private maxWaitTimer: number | null = null;
  /**
   * Identifies the current end-of-turn resolution attempt (settle timer + gate call).
   * Bumped whenever new speech arrives or we fire/reset, so a settle callback or a slow
   * gate result from a superseded attempt is ignored. This is the debounce that keeps at
   * most one in-flight resolution per utterance.
   */
  private attemptId = 0;
  /** Whether the SETTLE_MS quiet window has elapsed for the current attempt. */
  private settleElapsed = false;
  /** The current attempt's gate verdict once it resolves, else null. */
  private gateDecision: GateDecision | null = null;

  public constructor(private readonly options: TurnDetectorOptions) {}

  /**
   * Feed a FINAL them-channel transcript segment (is_final=true only — never interim).
   * `speechFinal` is Deepgram's speech_final flag for this segment.
   */
  public handleThemFinal(text: string, speechFinal: boolean): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    // New speech supersedes any in-flight settle+gate attempt (Part D #1).
    this.cancelAttempt();

    // Append BEFORE evaluating so the gate judges the FULL buffer — including the last
    // words and any closing "?" (Part D #6). Evaluating first would look incomplete.
    this.segments.push(trimmed);
    // This segment's flag governs the (now-current) buffer; a prior speech_final only
    // covered the shorter buffer that preceded this append.
    this.speechFinalSeen = speechFinal;
    if (this.state === "IDLE") this.setState("ACCUMULATING");
    this.log("append", `"${trimmed}" (speech_final=${speechFinal}) -> "${this.utterance}"`);

    // Keep the MAX_WAIT clock measuring silence-since-last-speech once past a candidate.
    if (this.maxWaitTimer !== null) this.restartMaxWait();

    if (speechFinal) {
      this.enterCandidateEnd();
    } else {
      // Non-final words extend the buffer; wait for the next end signal (speech_final
      // or UtteranceEnd) rather than gating mid-growth.
      this.setState("ACCUMULATING");
    }
  }

  /**
   * Feed a them-channel UtteranceEnd signal. `lastWordEnd` is Deepgram's last_word_end;
   * -1 means there is no pending utterance (stale/duplicate) and is ignored.
   */
  public handleThemUtteranceEnd(lastWordEnd: number | undefined): void {
    if (lastWordEnd === -1) {
      this.log("utterance_end", "ignored (last_word_end=-1, stale/duplicate)");
      return;
    }
    if (this.segments.length === 0) {
      this.log("utterance_end", "ignored (empty buffer)");
      return;
    }
    if (this.speechFinalSeen) {
      // speech_final already opened a candidate for this buffer; UtteranceEnd is redundant.
      this.log("utterance_end", "ignored (speech_final already seen for buffer)");
      return;
    }
    if (this.state === "SETTLING" || this.state === "CANDIDATE_END") {
      // An attempt initiated by a previous UtteranceEnd is already resolving.
      this.log("utterance_end", "ignored (resolution already in progress)");
      return;
    }
    this.log("utterance_end", `candidate end (last_word_end=${String(lastWordEnd)})`);
    this.enterCandidateEnd();
  }

  /**
   * Manual hotkey override: fire immediately, bypassing the gate and the settle window.
   * Always fires (the user explicitly asked), passing whatever them-buffer exists.
   */
  public forceFire(): void {
    const utterance = this.utterance;
    this.resetState();
    this.log("fire", `hotkey override: "${utterance}"`);
    this.options.onFire(utterance);
  }

  /** Reset all state and timers (e.g. when capture stops). */
  public reset(): void {
    this.resetState();
  }

  private get utterance(): string {
    return this.segments.join(" ").trim();
  }

  private enterCandidateEnd(): void {
    this.setState("CANDIDATE_END");
    // MAX_WAIT is measured from the first candidate end and reset on later speech.
    if (this.maxWaitTimer === null) this.restartMaxWait();
    this.beginSettleAndGate();
  }

  /** Start the settle timer and the gate call concurrently for a fresh attempt (#1). */
  private beginSettleAndGate(): void {
    const attempt = ++this.attemptId;
    this.settleElapsed = false;
    this.gateDecision = null;
    this.setState("SETTLING");

    const utterance = this.utterance;
    // Adaptive settle: an explicit "?" ending is a strong end-of-question signal,
    // so wait less before answering. Anything else keeps the patient default.
    const settleMs = utterance.endsWith("?") ? FAST_SETTLE_MS : SETTLE_MS;
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = null;
      if (attempt !== this.attemptId) return;
      this.settleElapsed = true;
      this.log("settle", `${settleMs}ms quiet elapsed`);
      this.tryResolve(attempt);
    }, settleMs);

    void this.runGate(attempt, utterance);
  }

  private async runGate(attempt: number, utterance: string): Promise<void> {
    let decision: GateDecision;
    try {
      decision = await this.options.gate(utterance);
    } catch {
      // The gate fails open internally, but never let a throw wedge the machine.
      decision = "COMPLETE";
    }

    // Superseded by new speech / a fire / a reset while we awaited the gate.
    if (attempt !== this.attemptId) {
      this.log("gate", `discarded stale ${decision} for "${utterance}"`);
      return;
    }

    this.gateDecision = decision;
    if (decision === "INCOMPLETE") {
      // Speaker is likely mid-sentence: drop the settle timer and keep listening.
      this.clearSettleTimer();
      this.setState("ACCUMULATING");
      this.log("gate", `INCOMPLETE -> keep listening: "${utterance}"`);
      return;
    }
    // COMPLETE: fire only once the settle window has also elapsed.
    this.tryResolve(attempt);
  }

  /** Fire when BOTH the gate says COMPLETE and the settle window has elapsed (#1). */
  private tryResolve(attempt: number): void {
    if (attempt !== this.attemptId) return;
    if (this.gateDecision === "COMPLETE" && this.settleElapsed) {
      this.fire("settle window elapsed + gate COMPLETE");
    }
  }

  /** Fire the buffered utterance through onFire, then return to IDLE. Skips empty buffers. */
  private fire(reason: string): void {
    const utterance = this.utterance;
    this.resetState();
    if (!utterance) {
      this.log("fire", `skipped (${reason}): empty buffer`);
      return;
    }
    this.log("fire", `${reason}: "${utterance}"`);
    this.options.onFire(utterance);
  }

  /** Clears buffer, timers, and per-attempt flags; invalidates any pending attempt. */
  private resetState(): void {
    this.clearSettleTimer();
    this.clearMaxWait();
    this.attemptId += 1;
    this.gateDecision = null;
    this.settleElapsed = false;
    this.segments.length = 0;
    this.speechFinalSeen = false;
    this.setState("IDLE");
  }

  /** Invalidates the in-flight attempt without touching the buffer or MAX_WAIT clock. */
  private cancelAttempt(): void {
    this.attemptId += 1;
    this.clearSettleTimer();
    this.gateDecision = null;
    this.settleElapsed = false;
  }

  private restartMaxWait(): void {
    this.clearMaxWait();
    this.maxWaitTimer = window.setTimeout(() => {
      this.maxWaitTimer = null;
      // MAX_WAIT exists for a buffer the gate never RESOLVED — not to overrule it. When
      // the gate has explicitly said "mid-sentence", firing answers a fragment: during a
      // real meeting this fired on "money on", "our capital." and "But they are", each at
      // full prompt cost and each aborting the answer to the question before it. Stand
      // down and leave the buffer intact; the words keep accumulating, and the next
      // candidate end re-arms this clock and re-runs the gate on the fuller utterance.
      // The manual ask hotkey still forces an answer if the gate is ever wrong.
      if (this.gateDecision === "INCOMPLETE") {
        this.log("max_wait", `${MAX_WAIT_MS}ms elapsed but gate says INCOMPLETE — still listening`);
        return;
      }
      this.log("max_wait", `${MAX_WAIT_MS}ms elapsed with no resolution — forcing fire`);
      this.fire("max wait");
    }, MAX_WAIT_MS);
  }

  private clearSettleTimer(): void {
    if (this.settleTimer !== null) {
      window.clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
  }

  private clearMaxWait(): void {
    if (this.maxWaitTimer !== null) {
      window.clearTimeout(this.maxWaitTimer);
      this.maxWaitTimer = null;
    }
  }

  private setState(next: TurnState): void {
    if (this.state === next) return;
    this.log("state", `${this.state} -> ${next}`);
    this.state = next;
  }

  private log(label: string, value: string): void {
    if (!this.options.debug) return;
    this.options.onLog?.(`Turn ${label}`, value);
  }
}
