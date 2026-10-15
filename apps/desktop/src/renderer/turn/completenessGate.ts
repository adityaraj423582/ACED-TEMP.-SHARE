/**
 * Completeness gate (Aced Part C) — decides whether a buffered them-utterance
 * reads as a finished question/request. Two layers:
 *
 *   Layer 1 (here, synchronous, no network): a cheap punctuation + stoplist heuristic
 *     that resolves the clear-cut cases (obvious endings, trailing conjunctions, very
 *     short fragments) without any round-trip.
 *   Layer 2 (injected `classify`, the /turn/complete backend call): a Groq YES/NO
 *     classifier for the AMBIGUOUS middle only. It fails OPEN to "complete".
 *
 * The result is a {@link CompletenessGate} the turn detector can call directly.
 */
import type { TurnCompleteResponse } from "@aced/shared";
import { type CompletenessGate, GATE_MIN_WORDS, type GateDecision } from "./turnDetector.js";

/** Heuristic verdict; AMBIGUOUS escalates to the Layer 2 classifier. */
type HeuristicVerdict = GateDecision | "AMBIGUOUS";

/**
 * Words that, when they END an utterance, signal the speaker is mid-thought. Lowercased,
 * punctuation-stripped. "you know" is handled separately as a two-word tail.
 */
const HANGING_WORDS = new Set<string>([
  "and",
  "but",
  "or",
  "so",
  "because",
  "if",
  "the",
  "a",
  "an",
  "to",
  "that",
  "with",
  "for",
  "of",
  "like",
  "um",
  "uh",
  "well",
  "then",
  "when",
  "which",
  "while",
  "as",
]);

function stripEdgePunctuation(word: string): string {
  return word.toLowerCase().replace(/[.,!?;:]+$/g, "");
}

/**
 * Layer 1 heuristic. Exported for testing/debug visibility.
 *   - COMPLETE: ends with terminal punctuation (. ? !) and not on a hanging word.
 *   - INCOMPLETE: ends on a hanging/stoplist word, or is a sub-GATE_MIN_WORDS fragment
 *     that does not end in "?".
 *   - AMBIGUOUS: everything else (no terminal punctuation, enough words) -> Layer 2.
 */
export function heuristicVerdict(utterance: string): HeuristicVerdict {
  const text = utterance.trim();
  if (!text) return "INCOMPLETE";

  const words = text.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const endsWithQuestion = text.endsWith("?");
  const endsWithTerminal = /[.?!]$/.test(text);

  const lastWord = stripEdgePunctuation(words[wordCount - 1] ?? "");
  const lastTwo = stripEdgePunctuation(words.slice(-2).join(" "));
  const endsOnHanging = HANGING_WORDS.has(lastWord) || lastTwo === "you know";

  // Very short fragments ("okay", "and", "um") read as incomplete unless a question
  // mark closed them ("What?"), which falls through to the terminal-punctuation rule.
  if (wordCount < GATE_MIN_WORDS && !endsWithQuestion) {
    return "INCOMPLETE";
  }
  // A trailing conjunction/filler means more is coming, even with terminal punctuation.
  if (endsOnHanging) {
    return "INCOMPLETE";
  }
  if (endsWithTerminal) {
    return "COMPLETE";
  }
  // No terminal punctuation but a real, non-hanging tail: let the classifier decide.
  return "AMBIGUOUS";
}

export interface CompletenessGateDeps {
  /**
   * Layer 2 classifier: returns the completeness verdict + its source. Backed by the
   * /turn/complete IPC call, which already fails open (complete=true) on timeout/error.
   */
  classify: (utterance: string) => Promise<TurnCompleteResponse>;
  /** When true, log gate decisions with their source (TURN_DEBUG). */
  debug?: boolean;
  onLog?: (label: string, value: string) => void;
}

/** Maps a Layer 2 response to the source-tagged debug label required by Part D #4. */
function layer2Label(result: TurnCompleteResponse): string {
  switch (result.source) {
    case "groq":
      return result.complete ? "groq:COMPLETE" : "groq:INCOMPLETE";
    case "timeout":
      return "groq:FAILOPEN(timeout)";
    case "parse":
      return "groq:FAILOPEN(parse)";
    case "error":
    default:
      return "groq:FAILOPEN(error)";
  }
}

/**
 * Builds the gate function injected into the TurnDetector. Layer 1 runs synchronously;
 * only AMBIGUOUS utterances hit Layer 2. The last Layer 2 result is cached per identical
 * buffer so re-evaluating the same text (e.g. while settling) issues no duplicate call.
 * Every decision is logged with its source so TURN_DEBUG shows whether Layer 2 is live.
 */
export function createCompletenessGate(deps: CompletenessGateDeps): CompletenessGate {
  let cache: { utterance: string; decision: GateDecision; label: string } | null = null;
  const log = (value: string): void => {
    if (deps.debug) deps.onLog?.("Turn gate", value);
  };

  return async (utterance: string): Promise<GateDecision> => {
    const verdict = heuristicVerdict(utterance);
    if (verdict !== "AMBIGUOUS") {
      log(`heuristic:${verdict} "${utterance}"`);
      return verdict;
    }

    if (cache && cache.utterance === utterance) {
      log(`${cache.label} (cached) "${utterance}"`);
      return cache.decision;
    }

    let decision: GateDecision;
    let label: string;
    try {
      const result = await deps.classify(utterance);
      decision = result.complete ? "COMPLETE" : "INCOMPLETE";
      label = layer2Label(result);
    } catch {
      // Belt-and-suspenders: classify already fails open, but never let a throw here
      // wedge the detector — treat an error as complete.
      decision = "COMPLETE";
      label = "groq:FAILOPEN(error)";
    }
    cache = { utterance, decision, label };
    log(`${label} "${utterance}"`);
    return decision;
  };
}
