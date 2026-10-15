/**
 * Tells the user's own voice apart from the other party's when both arrive on ONE
 * microphone — the Phone capture mode, where the laptop mic hears the interviewer
 * through the phone's speaker AND the user sitting in front of it.
 *
 * WHY THIS IS NEEDED
 * In Phone mode the microphone is wired to the "them" channel, so everything it picks
 * up is treated as the other party. That creates a feedback loop with a real cost: the
 * user reads an answer aloud, it is transcribed as an interviewer turn, the turn
 * detector fires, a NEW answer is generated from the user's own words, and the overlay
 * drifts further from the actual conversation the longer it runs.
 *
 * TWO SIGNALS, LAYERED
 *  1. Answer echo — if an utterance closely tracks an answer just shown on screen, it
 *     is the user reading it. Needs no setup and works from the very first turn.
 *  2. Diarisation — Deepgram labels each utterance with a speaker id. Ids alone are
 *     meaningless (nothing says which is the user), so signal 1 CALIBRATES signal 2:
 *     the speaker caught reading an answer is the user, and from then on everything
 *     from that id is suppressed, including speech that is not an answer echo.
 *
 * Bias: when uncertain, treat speech as the OTHER party. A false "that was me" drops a
 * real question and the user gets no answer at all, which is far worse than answering
 * one extra time.
 */

/** Answers stay echo-matchable for this long. Beyond it, similar wording is coincidence. */
const ECHO_WINDOW_MS = 120_000;

/** How many recent answers to keep for matching. */
const MAX_TRACKED_ANSWERS = 4;

/**
 * Fraction of an utterance's content words that must also appear in a recent answer
 * before it counts as the user reading it aloud.
 *
 * Deliberately high. People paraphrase rather than read verbatim, so a lower bar would
 * catch more real echoes — but it would also swallow genuine questions, because an
 * interviewer's follow-up naturally reuses the vocabulary of the answer they just heard.
 * Missing a real question is the expensive error, so this errs toward letting echoes
 * through rather than risking silence.
 */
const ECHO_SIMILARITY = 0.72;

/** Utterances shorter than this are too small for overlap to mean anything. */
const MIN_ECHO_WORDS = 5;

interface TrackedAnswer {
  words: Set<string>;
  at: number;
}

const recentAnswers: TrackedAnswer[] = [];

/** Diarisation id established as the user, once an echo has identified them. */
let userSpeakerId: number | null = null;

/** Content words only — filler carries no evidence either way. */
const FILLER = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "so",
  "to",
  "of",
  "in",
  "on",
  "at",
  "for",
  "with",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "it",
  "this",
  "that",
  "i",
  "you",
  "we",
  "they",
  "my",
  "your",
  "our",
  "their",
  "as",
  "by",
  "from",
  "not",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "will",
  "would",
  "can",
  "could",
  "should",
  "just",
  "like",
  "yeah",
  "okay",
  "ok",
  "um",
  "uh",
]);

function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !FILLER.has(w));
}

/**
 * Records an answer the overlay has just displayed, so speech matching it can be
 * recognised as the user reading it back.
 */
export function noteAnswerShown(text: string): void {
  const words = contentWords(text);
  if (words.length < MIN_ECHO_WORDS) return;
  recentAnswers.push({ words: new Set(words), at: Date.now() });
  while (recentAnswers.length > MAX_TRACKED_ANSWERS) recentAnswers.shift();
}

/** Clears all state — call on Master Clear and when capture stops. */
export function resetSelfVoice(): void {
  recentAnswers.length = 0;
  userSpeakerId = null;
}

/** Highest overlap between this utterance and any answer still inside the window. */
function echoScore(utterance: string): number {
  const words = contentWords(utterance);
  if (words.length < MIN_ECHO_WORDS) return 0;

  const now = Date.now();
  let best = 0;
  for (const answer of recentAnswers) {
    if (now - answer.at > ECHO_WINDOW_MS) continue;
    let hits = 0;
    for (const w of words) if (answer.words.has(w)) hits++;
    best = Math.max(best, hits / words.length);
  }
  return best;
}

export interface SelfVoiceVerdict {
  /** True when this utterance is the user's own voice and must not drive inference. */
  isUser: boolean;
  /** Why — for the debug log, so a wrong call can be diagnosed rather than guessed at. */
  reason: "echo" | "speaker" | "other";
}

/**
 * Decides whether an utterance came from the user rather than the other party.
 * `speakerId` is Deepgram's diarisation label when available.
 */
export function classifySpeech(utterance: string, speakerId?: number): SelfVoiceVerdict {
  // A known user speaker id is the strongest signal, and covers the user's ordinary
  // speech, not only answer read-backs.
  if (userSpeakerId !== null && speakerId === userSpeakerId) {
    return { isUser: true, reason: "speaker" };
  }

  if (echoScore(utterance) >= ECHO_SIMILARITY) {
    // Reading an answer aloud identifies this speaker as the user for the rest of the
    // session — the calibration step that makes diarisation usable.
    if (speakerId !== undefined && userSpeakerId === null) userSpeakerId = speakerId;
    return { isUser: true, reason: "echo" };
  }

  return { isUser: false, reason: "other" };
}

/** The learned user speaker id, or null. Exposed for logging only. */
export function getUserSpeakerId(): number | null {
  return userSpeakerId;
}
