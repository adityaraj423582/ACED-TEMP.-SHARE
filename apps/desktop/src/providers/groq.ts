import type { InferContextLine, InterviewRole, TurnCompleteResponse } from "@aced/shared";
import { MIND_ABOUT_ME, MIND_BASE_PROMPT, MIND_GUIDANCE, ROLE_BRIEF } from "@aced/shared";

/**
 * Direct Groq access from the Electron main process. No backend, no SDK — a
 * plain fetch to Groq's OpenAI-compatible endpoint keeps the dependency
 * surface tiny and removes a full network hop, which is the single biggest
 * latency win over the old desktop -> Railway -> Groq path.
 */
const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";

/** Mistral: OpenAI-compatible. Answer fallback, and the PRIMARY vision provider. */
const MISTRAL_CHAT_URL = "https://api.mistral.ai/v1/chat/completions";

/** Gemini's OpenAI-compatible endpoint. Vision fallback behind Mistral. */
const GEMINI_CHAT_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

/**
 * Answer model on Groq.
 *
 * llama-3.3-70b-versatile was decommissioned on 2026-08-16; requests to it stop being
 * served. GPT-OSS 120B is Groq's own recommended replacement and measured closest to
 * the old model here: 455ms to first token against Llama 3.3's 328ms, with the same
 * clean cue-bullet formatting.
 *
 * The alternative Groq suggested, Qwen3.6 27B, was rejected on measurement. It emits
 * its chain of thought as visible output, and suppressing that with
 * reasoning_format:"hidden" pushes first token to ~2.9s — the thinking still costs wall
 * time even once the tokens are hidden. That is far outside the budget for a line the
 * user reads aloud mid-conversation.
 */
const DEFAULT_MODEL = "openai/gpt-oss-120b";

/**
 * GPT-OSS reasons before answering, and that thinking is billed against max_tokens.
 * Left at its default, it either eats the whole budget and returns EMPTY or truncates
 * the answer mid-sentence (both observed). "low" keeps enough reasoning for a correct
 * answer while leaving room to actually write it, and cuts first token from 612ms to
 * 455ms as a side effect.
 */
const GROQ_REASONING: Record<string, unknown> = { reasoning_effort: "low" };

/**
 * Mistral answer model, used when Groq is down or rate-limited. Measured at ~600ms
 * first token with correct cue-bullet formatting — close enough to Groq that a
 * failover is barely noticeable.
 */
const DEFAULT_MISTRAL_MODEL = "mistral-medium-latest";

/**
 * Gemini vision fallback. Slower than Mistral (~5s vs ~2s first token) but correct,
 * and on a completely separate network path — so it covers a Mistral outage.
 */
const DEFAULT_GEMINI_VISION_MODEL = "gemini-3.6-flash";

/**
 * Second answer model on the SAME Groq key. Groq rate-limits each model separately, so
 * when the main model hits its per-minute ceiling (easy on a free-tier key) the answer
 * moves here instead of failing. Smaller, but fast and still clean at cue bullets.
 */
const DEFAULT_GROQ_FALLBACK_MODEL = "openai/gpt-oss-20b";

/**
 * Groq's own vision model: the last link of the vision chain, so the Code button works
 * with nothing but a Groq key. Measured on a screenshot: ~1.3s to first token with the
 * reasoning hidden, correct solution and complexity.
 */
const DEFAULT_GROQ_VISION_MODEL = "qwen/qwen3.8-27b";

/** Fast, cheap model for the YES/NO end-of-turn classifier. */
const DEFAULT_TURN_MODEL = "openai/gpt-oss-20b";

/**
 * Mistral's vision model — the PRIMARY for coding/explain. Chosen over Groq's
 * qwen3.6-27b after measuring both on the same screenshots: Mistral answered in
 * ~1.9s vs Groq's ~3.5s, and Groq's vision path failed three separate ways in one
 * day (model retired -> 404, reasoning tokens exhausting max_tokens -> empty answer,
 * and "over capacity" -> 503) on an 8k/minute budget that one screenshot nearly ate.
 */
const DEFAULT_VISION_MODEL = "mistral-medium-latest";

/**
 * TOTAL budget for an answer across the whole provider chain (not per provider).
 * A healthy answer lands in well under 2s, so 15s already allows a slow primary and
 * a fallback; longer just means more silence in front of the interviewer.
 */
const ANSWER_TIMEOUT_MS = 15_000;

/**
 * When to send a second, identical answer request if the first has shown nothing yet.
 * A healthy first line lands in ~0.4-0.8s; Groq's stalls run 1.3-3.5s (see streamHedged).
 */
const ANSWER_HEDGE_MS = 1_200;

/**
 * TOTAL budget for a coding/explain request across the whole provider chain (not per
 * provider). Measured: the model thinks silently for ~2s on an easy problem and ~5s
 * on a hard LeetCode/expected-value one, so 25s covers a slow primary plus a full
 * fallback attempt. Failing fast matters here — you can start reasoning aloud
 * yourself, but not while staring at a frozen "Reading your screen…".
 */
const CODING_TIMEOUT_MS = 25_000;

/**
 * Coding-interview system prompt. Approach-first, then code (the user's chosen
 * output style), language auto-detected from the screenshot, plain code with no
 * markdown fences so it renders cleanly in the overlay's text box.
 */
const CODING_SYSTEM_PROMPT = [
  "You are Aced in Problem-Solving mode for a technical AI / automation engineering interview.",
  "The user has screenshotted a problem on their screen. It may be ANY",
  "of these — silently identify the type, then use the matching format. NEVER print the category",
  "letter or its name: start directly with 'Approach:' or 'Answer:'.",
  "",
  "(A) CODING problem (LeetCode / HackerRank / SQL / pandas / an online editor):",
  "  1. 'Approach:' — 3-5 short lines: the intuition, the key data structure/algorithm, and WHY",
  "  it works, in plain words the user can say out loud.",
  "  2. The complete correct solution as PLAIN TEXT code — NO markdown fences or backticks.",
  "  Preserve indentation. Only the required function(s)/class, not a full program with",
  "  imports/main/IO boilerplate. Detect the language from the editor; default to Python.",
  "  3. A final line: 'Complexity: O(...) time, O(...) space.'",
  "",
  "(B) MATH / PROBABILITY / STATISTICS problem (expected value, combinatorics, distributions,",
  "Bayes, dice/cards/balls, variance, conditional probability):",
  "  1. 'Answer:' — the final result FIRST, on its own line, as an exact value (fraction or",
  "  simplified expression) plus the decimal in brackets, e.g. 'Answer: 3/28 (≈ 0.107)'.",
  "  2. 'Working:' — 2-5 short lines showing the actual steps/formula that produce it, the way",
  "  the user would say them aloud. Show the arithmetic, not just the name of the rule.",
  "  3. If a standard result/assumption is used (independence, uniformity, linearity of",
  "  expectation), name it in one short line.",
  "",
  "(C) QUANTITATIVE REASONING / PUZZLE (missing number in a sequence, distance-speed-time, work",
  "rate, ratios, brainteasers, logic, pattern finding):",
  "  1. 'Answer:' — the result FIRST on its own line.",
  "  2. 'Why:' — 2-4 short lines giving the rule/pattern and the check that confirms it (e.g.",
  "  'differences are 3, 5, 7, 9 → next difference 11'). Verify your answer against EVERY term or",
  "  condition given before committing to it.",
  "",
  "PLAIN TEXT ONLY — this is read aloud off a small overlay, not rendered:",
  "  - NO LaTeX. Never use $ ... $, \\frac{a}{b}, \\times, \\implies, \\sqrt, ^{ }, _{ } or any",
  "  backslash command. Write maths the way you would SAY it: '4/36 = 1/9', '(3/8) x (2/7)',",
  "  'E = 1 + 0.5E', 'sqrt(2)', 'x^2'.",
  "  - NO markdown. No **bold**, no *italics*, no ``` fences, no # headings, no tables.",
  "  - Keep the code itself clean and idiomatic with NO inline comment clutter — at most one",
  "  short comment where a line is genuinely non-obvious. The explanation belongs in 'Approach:',",
  "  not sprinkled through the code.",
  "ACCURACY IS THE PRIORITY. Compute carefully and re-check the arithmetic before answering; a",
  "confident wrong number is far worse than an extra second. If several readings of the problem",
  "are possible, solve the most likely one and note the assumption in one short line.",
  "",
  "If a PREVIOUS QUESTION & SOLUTION and/or RECENT TRANSCRIPT are provided, treat this as a likely",
  "FOLLOW-UP or MODIFICATION: keep what is still correct and change only what the tweak requires.",
  "Do NOT restate the problem. No markdown fences, no headings beyond the labels above. Be concise",
  "and fast to read — this is live. If the screenshot has no readable problem, say so in one line.",
].join(" ");

/**
 * Turn-classifier budget. This call goes straight to Groq (no proxy hop), so
 * 600ms is generous; it runs concurrently with the turn detector's settle
 * window, so it adds no perceived latency. Fails OPEN on timeout.
 */
const TURN_TIMEOUT_MS = 600;

const TURN_SYSTEM_PROMPT =
  "Live speech-to-text of one person on a call. Decide whether they have FINISHED their " +
  "turn — whether this stands on its own well enough that the listener could now respond. " +
  "Judge the WHOLE text, which may span several sentences, and expect no punctuation, " +
  "filler and run-on speech.\n" +
  "Answer NO when it is a sentence fragment, trails off mid-thought, continues an earlier " +
  "clause without completing an idea, or is only an acknowledgement or filler. Correct " +
  "grammar does not make it finished: a tidy fragment is still NO.\n" +
  "Answer YES when it is a question, an instruction, or a statement complete enough to " +
  "answer or react to — even if informal, ungrammatical or briefly phrased.\n" +
  "Reply with exactly one token: YES or NO.";

let diagnosticSink: ((message: string) => void) | null = null;

/**
 * Routes provider failures into the main process's diagnostics.log.
 *
 * Without this these lines only ever reached console.log, and the app is launched
 * detached with no reader on stdout — so every rate limit, auth failure and empty
 * response during a live call was lost. A failure nobody can read afterwards cannot
 * be fixed.
 */
export function setDiagnosticSink(sink: (message: string) => void): void {
  diagnosticSink = sink;
}

/**
 * Console logging that cannot crash the app. The overlay is normally launched
 * detached and the launching terminal is then closed, leaving stdout pointing at a
 * pipe with no reader — a plain console.log can raise EPIPE there. The sink is the
 * record that actually survives.
 */
function log(message: string): void {
  try {
    console.log(`[Aced] ${message}`);
  } catch {
    // No console attached; the sink below is then the only record.
  }
  try {
    diagnosticSink?.(message);
  } catch {
    // Logging must never break an answer.
  }
}

export class InferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InferError";
  }
}

function apiKey(): string {
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key) {
    throw new InferError("The Groq key is missing. Click Keys and add it.");
  }
  return key;
}

function answerModel(): string {
  return process.env.GROQ_MODEL?.trim() || DEFAULT_MODEL;
}

/**
 * One upstream a request can be sent to. All four providers speak the OpenAI
 * chat-completions dialect, so only the small per-vendor quirks live here.
 */
interface Provider {
  /** Shown in diagnostics only. */
  name: string;
  url: string;
  /** Env var holding the key. A provider with no key is skipped silently. */
  envKey: string;
  model: string;
  /** Merged into the request body (e.g. Groq's reasoning_format). */
  extra?: Record<string, unknown>;
  /**
   * Mistral takes `image_url` as a bare string; OpenAI/Groq/Gemini take
   * `{ url }`. Getting this wrong is a 400 with an unhelpful message.
   */
  imageAsString?: boolean;
}

function providerKey(provider: Provider): string | undefined {
  return process.env[provider.envKey]?.trim() || undefined;
}

/** How long a provider is skipped after it rate-limits us. */
const RATE_LIMIT_COOLDOWN_MS = 60_000;

/** provider name -> epoch ms until which it is skipped for rate-limiting. */
const rateLimitedUntil = new Map<string, number>();

/**
 * Drops providers that recently returned 429, so a rate limit costs one wasted round
 * trip per minute instead of one per question.
 *
 * Measured need: a key whose plan allows zero requests per minute answered 429 to every
 * call, yet sat in the middle of the chain — so every fallback paid its round trip before
 * reaching a provider that works. Groq's own per-minute ceiling behaves the same way once
 * a burst trips it. If every provider is cooling, the cooldown is ignored rather than
 * leaving the user with no answer at all.
 */
function readyProviders(providers: Provider[]): Provider[] {
  const now = Date.now();
  const ready = providers.filter((p) => (rateLimitedUntil.get(p.name) ?? 0) <= now);
  return ready.length > 0 ? ready : providers;
}

/**
 * Answer chain, in tuned order: Groq first for its ~500ms first token, then Mistral
 * (~600ms), then Gemini (slower — it thinks before answering — but a wholly separate
 * network path). A failure at any point continues down the list silently.
 *
 * `prefer` moves one provider to the FRONT rather than dropping the others, so a
 * manual choice never costs you the fallback safety net mid-interview.
 */
function answerProviders(prefer?: string): Provider[] {
  const all: Provider[] = [
    {
      name: "groq",
      url: GROQ_CHAT_URL,
      envKey: "GROQ_API_KEY",
      model: answerModel(),
      extra: GROQ_REASONING,
    },
    {
      name: "groq-fallback",
      url: GROQ_CHAT_URL,
      envKey: "GROQ_API_KEY",
      model: process.env.GROQ_FALLBACK_MODEL?.trim() || DEFAULT_GROQ_FALLBACK_MODEL,
      extra: GROQ_REASONING,
    },
    {
      name: "mistral",
      url: MISTRAL_CHAT_URL,
      envKey: "MISTRAL_API_KEY",
      model: process.env.MISTRAL_MODEL?.trim() || DEFAULT_MISTRAL_MODEL,
    },
    {
      name: "gemini",
      url: GEMINI_CHAT_URL,
      envKey: "GEMINI_API_KEY",
      model: process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_VISION_MODEL,
    },
  ];
  if (!prefer || prefer === "auto") return all;
  const chosen = all.filter((p) => p.name === prefer);
  return chosen.length ? [...chosen, ...all.filter((p) => p.name !== prefer)] : all;
}

/**
 * Vision chain: Mistral first (fastest + by far the largest token budget), Gemini
 * behind it on an entirely separate network path, then Groq's own vision model so a
 * Groq key alone is enough. Providers without a key are skipped.
 */
function visionProviders(): Provider[] {
  return [
    {
      name: "mistral",
      url: MISTRAL_CHAT_URL,
      envKey: "MISTRAL_API_KEY",
      model: visionModel(),
      imageAsString: true,
    },
    {
      name: "gemini",
      url: GEMINI_CHAT_URL,
      envKey: "GEMINI_API_KEY",
      model: process.env.GEMINI_VISION_MODEL?.trim() || DEFAULT_GEMINI_VISION_MODEL,
    },
    {
      name: "groq-vision",
      url: GROQ_CHAT_URL,
      envKey: "GROQ_API_KEY",
      model: process.env.GROQ_VISION_FALLBACK_MODEL?.trim() || DEFAULT_GROQ_VISION_MODEL,
      // Qwen streams its chain of thought as visible text unless told to hide it.
      extra: { reasoning_format: "hidden" },
    },
  ];
}

/** Builds the user message, formatting the image the way `provider` expects. */
function userContent(provider: Provider, text: string, imageDataUrl?: string): unknown {
  if (!imageDataUrl) return text;
  return [
    { type: "text", text },
    {
      type: "image_url",
      image_url: provider.imageAsString ? imageDataUrl : { url: imageDataUrl },
    },
  ];
}

/** One streaming request to one provider. Throws on a non-2xx response. */
async function streamOnce(
  provider: Provider,
  body: Record<string, unknown>,
  signal: AbortSignal,
  onDelta: (text: string) => void,
): Promise<StreamOutcome> {
  const res = await fetch(provider.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${providerKey(provider) ?? ""}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${detail.slice(0, 120).replace(/\s+/g, " ")}`);
  }
  return pumpSseDeltas(res, onDelta);
}

/**
 * A hedged request: if the first request has not produced a line within `hedgeAfterMs`, an
 * identical second one is sent, and whichever produces a line first is shown while the
 * other is cancelled.
 *
 * Measured need: GPT-OSS 120B on Groq returns headers in ~0.3s but then, on roughly one
 * request in three, stalls 1.3-3.5s before its first token — the same question took 0.35s
 * and 3.4s back to back, with identical prompt and output sizes, so the delay is on Groq's
 * side and a fresh request usually avoids it. Same model, so answer quality is unchanged;
 * the extra tokens are only spent on requests that were already slow.
 */
function streamHedged(
  provider: Provider,
  body: Record<string, unknown>,
  signal: AbortSignal,
  hedgeAfterMs: number,
  onDelta: (text: string) => void,
): Promise<StreamOutcome> {
  return new Promise((resolve, reject) => {
    const controllers: AbortController[] = [];
    let winner: number | null = null;
    let running = 0;
    let settled = false;
    let hedgeTimer: NodeJS.Timeout | null = null;

    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      if (hedgeTimer) clearTimeout(hedgeTimer);
      finish();
    };

    const launch = (): void => {
      if (hedgeTimer) clearTimeout(hedgeTimer);
      const id = controllers.length;
      const controller = new AbortController();
      controllers.push(controller);
      running += 1;

      const failed = (err: unknown): void => {
        if (winner === id) {
          settle(() => reject(err)); // Failed mid-answer: no second answer on top of it.
          return;
        }
        if (winner !== null || settled) return; // The cancelled loser.
        const message = err instanceof Error ? err.message : String(err);
        // A quick failure gets one immediate retry, unless it is a rate limit (a second
        // identical request would only be refused too) or the user cancelled.
        if (controllers.length === 1 && !message.includes("HTTP 429") && !signal.aborted) {
          launch();
        } else if (running === 0) {
          settle(() => reject(err));
        }
      };

      streamOnce(provider, body, AbortSignal.any([signal, controller.signal]), (text) => {
        if (winner === null) {
          winner = id;
          if (hedgeTimer) clearTimeout(hedgeTimer);
          controllers.forEach((other, index) => {
            if (index !== id) other.abort();
          });
          if (id > 0) log(`${provider.name}: hedged request answered first`);
        }
        if (winner === id) onDelta(text);
      }).then(
        (outcome) => {
          running -= 1;
          if (winner === id) settle(() => resolve(outcome));
          else if (!outcome.emitted) {
            failed(new Error(`empty response (finish_reason=${outcome.finishReason ?? "none"})`));
          }
        },
        (err: unknown) => {
          running -= 1;
          failed(err);
        },
      );
    };

    launch();
    hedgeTimer = setTimeout(() => {
      if (winner === null && !settled && controllers.length === 1) launch();
    }, hedgeAfterMs);
  });
}

/**
 * Streams a completion, transparently failing over down `providers`.
 *
 * Failover only happens while NOTHING has been shown yet: once text is on screen,
 * switching upstream would append a second answer to a half-finished one. Anything
 * short of that — network error, 429, 503, a retired model, or a reasoning model
 * that burns its budget and returns nothing — moves silently to the next provider,
 * so a live interview never sees an error the app could have handled itself.
 */
async function streamWithFallback(options: {
  providers: Provider[];
  buildBody: (provider: Provider) => Record<string, unknown>;
  signal: AbortSignal;
  onDelta: (text: string) => void;
  timeoutMs: number;
  /** Used in the final error if every provider fails. */
  label: string;
  /** When set, the FIRST provider's request is hedged after this many ms (see streamHedged). */
  hedgeAfterMs?: number;
}): Promise<void> {
  const configured = options.providers.filter((p) => providerKey(p));
  const usable = readyProviders(configured);
  if (configured.length === 0) {
    throw new InferError(
      `No API key configured for ${options.label}. Click Keys and add your Groq key.`,
    );
  }

  const failures: string[] = [];
  // ONE deadline for the whole chain, not one per provider. Per-provider timeouts
  // stacked: a hung primary burned its full budget, then the fallback started a fresh
  // one, so the user could wait 2x the timeout staring at a frozen box mid-interview.
  // Each attempt gets whatever is left, with a floor so the last provider still gets
  // a fair chance rather than being handed a few milliseconds.
  const deadline = Date.now() + options.timeoutMs;
  const MIN_ATTEMPT_MS = 6_000;

  for (const [index, provider] of usable.entries()) {
    const remaining = deadline - Date.now();
    if (index > 0 && remaining <= 0) {
      failures.push(`${provider.name}: skipped (no time left in budget)`);
      break;
    }
    const timeoutController = new AbortController();
    const timeout = setTimeout(
      () => timeoutController.abort(),
      Math.max(remaining, MIN_ATTEMPT_MS),
    );
    const signal = AbortSignal.any([options.signal, timeoutController.signal]);
    let started = false;
    try {
      const body = { ...options.buildBody(provider), ...provider.extra };
      const forward = (text: string): void => {
        started = true;
        options.onDelta(text);
      };
      const result =
        index === 0 && options.hedgeAfterMs
          ? await streamHedged(provider, body, signal, options.hedgeAfterMs, forward)
          : await streamOnce(provider, body, signal, forward);
      if (!result.emitted) {
        // Reasoning models can spend the whole budget thinking and say nothing.
        throw new Error(`empty response (finish_reason=${result.finishReason ?? "none"})`);
      }
      if (index > 0) {
        log(`${options.label}: served by ${provider.name} (fallback)`);
      }
      return;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // The user cancelled (new question, Master Clear) — not a provider problem.
      if (options.signal.aborted) throw err;
      failures.push(`${provider.name}: ${message}`);
      log(`${options.label}: ${provider.name} failed (${message})`);
      if (message.includes("HTTP 429")) {
        rateLimitedUntil.set(provider.name, Date.now() + RATE_LIMIT_COOLDOWN_MS);
        log(`${provider.name}: rate limited — skipping it for ${RATE_LIMIT_COOLDOWN_MS / 1000}s`);
      }
      // Text already on screen: a second upstream would append a duplicate answer.
      if (started) throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new InferError(`${options.label} failed on every provider. ${failures.join(" | ")}`);
}

function turnModel(): string {
  return process.env.GROQ_TURN_MODEL?.trim() || DEFAULT_TURN_MODEL;
}

function visionModel(): string {
  return process.env.GROQ_VISION_MODEL?.trim() || DEFAULT_VISION_MODEL;
}

/**
 * Reads a Groq OpenAI-compatible SSE stream and forwards each text delta to
 * onDelta. Shared by the text-answer and coding-vision streamers.
 */
/**
 * Strips LaTeX/markdown the models still emit despite the prompt asking for plain
 * text. The overlay renders raw text, so "$E = \frac{1}{2}$" reaches the user
 * literally — unreadable when you are reading it aloud under pressure.
 *
 * Every rule is deliberately narrow so it cannot corrupt real CODE, which legitimately
 * contains `**` (Python power), `#` (comments), `\n` (string escapes) and braces:
 * only named LaTeX commands and paired markdown bold are touched. Nothing here
 * rewrites a bare backslash, a lone brace, or a `#` at line start.
 */
function stripRenderMarkup(text: string): string {
  return (
    text
      // \frac{1}{2} and \dfrac/\tfrac -> 1/2
      .replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "$1/$2")
      .replace(/\\sqrt\s*\{([^{}]*)\}/g, "sqrt($1)")
      // \text{...}, \mathrm{...} -> the contents
      .replace(/\\(?:text|textbf|mathrm|mathbf|mathit|operatorname)\s*\{([^{}]*)\}/g, "$1")
      // Named symbols, written the way they'd be spoken.
      .replace(/\\(?:times)\b/g, "x")
      .replace(/\\(?:cdot)\b/g, ".")
      .replace(/\\(?:div)\b/g, "/")
      .replace(/\\(?:implies|Rightarrow|rightarrow|to)\b/g, "=>")
      .replace(/\\(?:leq|le)\b/g, "<=")
      .replace(/\\(?:geq|ge)\b/g, ">=")
      .replace(/\\(?:neq|ne)\b/g, "!=")
      .replace(/\\(?:approx)\b/g, "~=")
      .replace(/\\(?:pm)\b/g, "+/-")
      .replace(/\\(?:infty)\b/g, "infinity")
      .replace(/\\(?:sum)\b/g, "sum")
      .replace(/\\(?:prod)\b/g, "product")
      .replace(/\\(?:alpha|beta|gamma|delta|theta|lambda|mu|sigma|pi|rho|phi|omega)\b/g, (m) =>
        m.slice(1),
      )
      // Spacing/grouping commands that carry no meaning in plain text.
      .replace(/\\(?:left|right|qquad|quad)\b/g, "")
      .replace(/\\[,;!]/g, "")
      // E_{H} -> E_H, x^{2} -> x^2
      .replace(/([_^])\{([^{}]+)\}/g, "$1$2")
      // Inline/display math delimiters.
      .replace(/\\[()[\]]/g, "")
      // A currency amount keeps its meaning ("$4.60" -> "4.60 dollars") instead of
      // losing the symbol along with the LaTeX delimiters.
      .replace(/\$(\d[\d,]*(?:\.\d+)?)(?![\w^{}\\$])/g, "$1 dollars")
      .replace(/\$+/g, "")
      // Markdown bold. Requires non-space just inside, so Python's `a ** b` survives.
      .replace(/\*\*(\S(?:[^*]*\S)?)\*\*/g, "$1")
      // Stray fences (the prompt bans them, but they slip through occasionally).
      .replace(/```[a-zA-Z]*/g, "")
  );
}

/** Outcome of one SSE stream, so the caller can decide whether to fail over. */
interface StreamOutcome {
  /** True once any visible text reached the overlay. */
  emitted: boolean;
  /** Why the model stopped; "length" means it ran out of budget mid-answer. */
  finishReason?: string;
}

async function pumpSseDeltas(
  res: Response,
  onDelta: (text: string) => void,
): Promise<StreamOutcome> {
  if (!res.body) {
    throw new InferError("Response had no body stream.");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Safety net for reasoning models: if a "<think> …" monologue is ever emitted
  // despite reasoning_effort:"none", swallow it rather than streaming the model's
  // scratch work into the overlay. Text after </think> flows through normally.
  let inThinkBlock = false;
  const emit = (delta: string): void => {
    let text = delta;
    if (inThinkBlock) {
      const close = text.indexOf("</think>");
      if (close === -1) return;
      text = text.slice(close + "</think>".length);
      inThinkBlock = false;
    }
    const open = text.indexOf("<think>");
    if (open !== -1) {
      const before = text.slice(0, open);
      const close = text.indexOf("</think>", open);
      if (close === -1) {
        inThinkBlock = true;
        text = before;
      } else {
        text = before + text.slice(close + "</think>".length);
      }
    }
    if (text) buffer_(text);
  };
  let emitted = false;
  let finishReason: string | undefined;

  /**
   * Holds text until a whole line is available: a single SSE delta can split
   * "\frac{1}{2}" or "**bold**" across chunks, and cleaning half a sequence would
   * either miss it or mangle it. Streaming a line at a time also reads better on a
   * teleprompter than character-by-character flicker.
   */
  let pending = "";
  /** Flush anyway past this, so a long unbroken paragraph still streams. */
  const MAX_PENDING = 400;

  const send = (text: string): void => {
    if (!text) return;
    emitted = true;
    onDelta(stripRenderMarkup(text));
  };
  const buffer_ = (text: string): void => {
    pending += text;
    const lastNewline = pending.lastIndexOf("\n");
    if (lastNewline >= 0) {
      send(pending.slice(0, lastNewline + 1));
      pending = pending.slice(lastNewline + 1);
    } else if (pending.length > MAX_PENDING) {
      // No newline in sight — break at the last space so words stay intact.
      const cut = pending.lastIndexOf(" ");
      const at = cut > 0 ? cut + 1 : pending.length;
      send(pending.slice(0, at));
      pending = pending.slice(at);
    }
  };
  const flushPending = (): void => {
    send(pending);
    pending = "";
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line.startsWith("data:")) continue;
      const data = line.slice("data:".length).trim();
      if (data === "[DONE]") {
        flushPending();
        return { emitted, finishReason };
      }
      try {
        const parsed = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
        };
        const choice = parsed.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta?.content;
        if (delta) emit(delta);
      } catch {
        // Ignore unparseable keep-alive/comment lines.
      }
    }
  }
  flushPending();
  return { emitted, finishReason };
}

/**
 * Builds the answer system prompt: the user's own mind (how they answer, who they are) plus
 * the role being interviewed for.
 */
function buildSystemPrompt(role: InterviewRole): string {
  return [MIND_BASE_PROMPT, MIND_GUIDANCE, MIND_ABOUT_ME, ROLE_BRIEF[role]].join("\n\n");
}

/**
 * Questions about the person rather than the work. The model answers these by inventing detail
 * (a denial that AI helped, a salary band, a weekend) often enough to matter, and the prompt rule
 * alone was not reliable, so a match adds an explicit instruction next to the question itself.
 */
const HARD_STOPS: { pattern: RegExp; reply: string }[] = [
  {
    pattern:
      /\b(salary|salaries|compensation|ctc|expected pay|(are|get|being) you paid|your (pay|package|bonus)|how much (do|would|did) you (earn|make|get)|what (do|would|did) you (earn|get paid))\b|\bdo you earn\b/i,
    reply: "something like 'Happy to discuss that once I understand the role and the full package'. NO figure, no market rate, no package",
  },
  {
    pattern:
      /\b(married|marital|wife|husband|girlfriend|boyfriend|kids?|children|how old|your age|birthday|date of birth|religion|religious|politic\w*|your health)\b|\byour (home ?town|address)\b/i,
    reply: "something like 'I'd rather keep that private'. State, guess and describe nothing",
  },
  {
    pattern:
      /\bnotice period\b|\b(when|how soon) can you (join|start)\b|\bjoining date\b|\b(relocat\w*|shift to ahmedabad|move to ahmedabad)\b/i,
    reply: "a positive, flexible line such as 'I'll confirm my exact notice period, and I'm happy to work with you on an early joining date'. NO number of days, weeks or months, no date",
  },
  {
    pattern: /\b(how are you|how was your (day|week|weekend)|what did you do (today|yesterday|last night|at the weekend|over the weekend))\b/i,
    reply: "a warm neutral line that turns it back, like 'Good, thanks - how about you?'. Mention no activity, hobby or place",
  },
];

/**
 * Questions probing a detail of the user's past work that the CV does not hold (team size,
 * accuracy, which documents or clients). Measured: with only the system-prompt rule, the
 * model answered "how big was your team" with "five to seven engineers" and "what accuracy"
 * with "ninety-two percent" — so a match adds an explicit instruction at the very end.
 */
const UNRECORDED_DETAIL =
  /\b(how (big|large) (was|is) (your|the) team|team size|how many (people|engineers|users|customers|clients|documents|records)|(what|which) (was|is) (the|your) accuracy|what accuracy|accuracy (did|was|of)|precision|recall|f1|which (clients?|customers|companies|industr\w*)|what (kind|type)s? of (documents|data|files|clients|customers|chatbots?|bots?)|(what|which) documents)\b/i;

function unrecordedDetailHint(context: InferContextLine[]): string {
  const latest = [...context].reverse().find((l) => l.speaker !== "you")?.text ?? "";
  if (!UNRECORDED_DETAIL.test(latest) || !/\b(you|your|yours)\b/i.test(latest)) return "";
  return (
    "THIS ASKS FOR A DETAIL MY CV DOES NOT RECORD. Point 1 answers honestly WITHOUT inventing it: " +
    "describe it only in general terms (e.g. 'unstructured business documents like scanned PDFs', " +
    "'a small team'), or say I'd rather not quote an exact figure I can't state precisely. State NO " +
    "number, size, percentage, team member or role, document type, client, industry or tool that " +
    "ABOUT ME does not contain. Then add what IS recorded."
  );
}

/**
 * The closing check on every answer, placed last so it is the final thing the model reads.
 * The rule already sits in the system prompt, but measured answers still borrowed the target
 * role's example domains (invoices, tenants) and attached them to past jobs.
 */
const FACT_GUARD =
  "FINAL CHECK before writing: every fact about MY past work must be literally in ABOUT ME. " +
  "Never describe my past work with the TARGET ROLE's examples (invoices, contracts, tenancy, " +
  "tenants, property, compliance certificates, accounting systems) and never add a number, tool " +
  "(no Tesseract, Kubernetes, AWS, Airflow, Prometheus), team member, launch or next step that is " +
  "not written there. Ideas for THEM are fine; history about ME is only what is written.";

function hardStopHint(context: InferContextLine[]): string {
  const latest = [...context].reverse().find((l) => l.speaker !== "you")?.text ?? "";
  const hit = HARD_STOPS.find((h) => h.pattern.test(latest));
  if (!hit) return "";
  return (
    "OVERRIDE FOR THIS QUESTION: reply with exactly ONE line, one '• ' point and nothing after it " +
    "(this replaces the 3-4 point rule above): " + hit.reply + "."
  );
}

function buildUserMessage(context: InferContextLine[], sessionMemory?: string): string {
  const transcript = context
    .map((line) => `${line.speaker === "you" ? "You" : "Them"}: ${line.text}`)
    .join("\n");
  const parts: string[] = [];
  if (sessionMemory?.trim()) {
    parts.push(
      "SESSION SO FAR (running memory of this conversation — earlier coding questions, the code/" +
        "solutions you gave, and prior answers). Use it as context: if the interviewer's question " +
        "is a follow-up about the code (complexity, optimisation, why this approach, edge cases, a " +
        "bug, a modification) or refers to something earlier, answer DIRECTLY from this — never ask " +
        "them to paste a snippet. It is what I already said and may contain mistakes - never treat it " +
        "as a source of facts or numbers:\n" +
        sessionMemory.trim(),
    );
  }
  parts.push(`Live interview transcript so far:\n\n${transcript}`);
  parts.push(
    'Answer their LATEST turn as teleprompter points. Every point starts with "• " on its ' +
      "own line, <=25 words. Point 1 IS the direct answer - never restate the question, no " +
      "preamble. Later points must support it. COUNT: 3 or 4 points, never more than 4; never " +
      "pad to reach a number. ANY QUESTION ON ANY SUBJECT - maths, English, history, finance, " +
      "economics, science, general knowledge, a puzzle - gets a correct, textbook-quality answer " +
      "with the fact or number first: answer it, never deflect it, never turn it into a story " +
      "about my CV. Never end with filler such as 'you can verify' or 'check the latest'. Never " +
      "write a point that only comments on the answer itself ('this is exact', 'no further steps " +
      "needed'): every point adds substance. Salary or CTC, age, marital status, family, and small " +
      "talk: ONE point only, a neutral line (the one exception to the 3-point minimum). NO LIVE " +
      "DATA: never state a current price, rate or news item as fact. If they ask SEVERAL distinct " +
      "questions in one turn, answer EVERY part, one point each, in the order asked, up to 4.\n" +
      "FOLLOW-UPS ('why that one?', 'what if...', 'and if it failed?') name no subject - read " +
      "back up the transcript, find what they mean, and answer IN THAT CONTEXT. Never restart " +
      "on a new topic, never repeat points already given, go one level deeper.\n" +
      "If they ask me to WRITE a query/function/snippet: one short approach point, then the " +
      "complete code on its own lines - I have to type it.\n" +
      "'TELL ME ABOUT YOURSELF': 4 points - who I am and my degree, BeyondData, Appstane, and " +
      "why this automation role fits. PROJECT WALKTHROUGH ('tell me about a project'): 4 points - " +
      "the problem, the approach and stack and why, the real result, and what I would do next. If " +
      "they NAME something, answer about THAT; only when nothing is named do I choose, and then " +
      "the most relevant real work for an automation role: the BeyondData OCR and NLP document " +
      "pipelines or the Appstane RAG systems. Then stop and let their follow-ups steer the depth.",
  );
  // Last, so it is the final word the model reads: placed before the general rules, the
  // "3 or 4 points" count won and a one-line hard stop came back as three points.
  const hardStop = hardStopHint(context);
  if (hardStop) {
    parts.push(hardStop);
  } else {
    const unrecorded = unrecordedDetailHint(context);
    if (unrecorded) parts.push(unrecorded);
    parts.push(FACT_GUARD);
  }
  return parts.join("\n\n");
}

export interface StreamAnswerOptions {
  context: InferContextLine[];
  /** The role the user is interviewing for; tailors the answer emphasis. */
  role: InterviewRole;
  /** Running session memory (prior questions, code, answers) for context. */
  sessionMemory?: string;
  /** Moves one provider to the front of the chain; "auto"/undefined keeps the order. */
  preferProvider?: string;
  signal: AbortSignal;
  onDelta: (text: string) => void;
}

/**
 * Streams an answer, forwarding each text delta to onDelta. Tries Groq's main model first
 * for its ~500ms first token and silently continues down the chain (Groq's second model,
 * then any other configured provider) if it is down, rate-limited, or returns nothing.
 * Throws InferError only if every provider fails.
 */
export async function streamAnswer(options: StreamAnswerOptions): Promise<void> {
  const systemPrompt = buildSystemPrompt(options.role);
  const userMessage = buildUserMessage(options.context, options.sessionMemory);

  await streamWithFallback({
    providers: answerProviders(options.preferProvider),
    signal: options.signal,
    onDelta: options.onDelta,
    timeoutMs: ANSWER_TIMEOUT_MS,
    label: "Answer",
    // GROQ_HEDGE_MS overrides the delay; 0 turns hedging off.
    hedgeAfterMs: Number(process.env.GROQ_HEDGE_MS ?? ANSWER_HEDGE_MS) || undefined,
    buildBody: (provider) => ({
      model: provider.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      stream: true,
      // Length is set by the PROMPT, not by this ceiling — the model writes only the
      // points it was asked for. The headroom exists because GPT-OSS bills its REASONING
      // against this budget: at 400 it returned empty, and at 900 a long-prompt answer
      // truncated mid-sentence after two points. Raising it costs nothing when unused.
      max_tokens: 1600,
      temperature: 0.25,
    }),
  });
}

/** Converts a finished solution into language-agnostic pseudo code on request. */
const PSEUDOCODE_SYSTEM_PROMPT = [
  "You convert a given coding solution into clear, LANGUAGE-AGNOSTIC pseudo code that mirrors its",
  "exact approach. Output ONLY the pseudo code — no prose before or after, no markdown fences.",
  "Use plain structured keywords (FUNCTION, FOR EACH, WHILE, IF / ELSE, RETURN), indentation for",
  "nesting, and short descriptive steps. Stay faithful to the logic of the provided solution; do",
  "not invent a different algorithm. Keep it concise and easy to read aloud or write on a board.",
].join(" ");

export interface StreamPseudocodeOptions {
  /** Running session memory; the most recent solution in it is converted to pseudo code. */
  sessionMemory: string;
  signal: AbortSignal;
  onDelta: (text: string) => void;
}

/**
 * Streams pseudo code derived from a previous solution (Groq text model). Used when
 * the interviewer asks for the pseudo code of the approach already given.
 */
export async function streamPseudocode(options: StreamPseudocodeOptions): Promise<void> {
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), ANSWER_TIMEOUT_MS);
  const signal = AbortSignal.any([options.signal, timeoutController.signal]);

  try {
    const res = await fetch(GROQ_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: answerModel(),
        messages: [
          { role: "system", content: PSEUDOCODE_SYSTEM_PROMPT },
          {
            role: "user",
            content:
              "From the session below, take the MOST RECENT coding solution and convert it into " +
              `pseudo code:\n\n${options.sessionMemory.slice(0, 6_000)}`,
          },
        ],
        stream: true,
        max_tokens: 1024,
        temperature: 0.2,
        // Same reasoning cap as the answer path: without it GPT-OSS spends the token
        // budget thinking and returns nothing.
        ...GROQ_REASONING,
      }),
      signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new InferError(`Groq request failed (HTTP ${res.status}). ${detail.slice(0, 200)}`);
    }
    await pumpSseDeltas(res, options.onDelta);
  } finally {
    clearTimeout(timeout);
  }
}

export interface StreamCodingAnswerOptions {
  /** A PNG/JPEG screenshot as a data URL (data:image/png;base64,...). */
  imageDataUrl: string;
  /** Recent spoken transcript, so a verbally-modified question is understood. */
  recentTranscript?: string;
  /** Running session memory (prior questions, code, answers) for follow-ups/modifications. */
  sessionMemory?: string;
  signal: AbortSignal;
  onDelta: (text: string) => void;
}

/** Builds the coding user-message text, folding in the running session memory. */
function buildCodingUserText(options: StreamCodingAnswerOptions): string {
  const parts: string[] = [];
  if (options.sessionMemory?.trim()) {
    parts.push(
      "SESSION SO FAR (earlier questions, the code you gave, prior answers). The current request " +
        "may be a follow-up or MODIFICATION of this — keep the still-valid parts and change only " +
        `what's needed, continuing rather than rewriting:\n${options.sessionMemory.trim()}`,
    );
  }
  if (options.recentTranscript?.trim()) {
    parts.push(
      "RECENT TRANSCRIPT (what the interviewer just said — may contain a verbal tweak to the " +
        `question):\n${options.recentTranscript.trim().slice(0, 2_000)}`,
    );
  }
  parts.push("Solve the coding question shown in this screenshot.");
  return parts.join("\n\n");
}

/** Explain mode: explains the on-screen code's logic, grounded in the session memory. */
const EXPLAIN_SYSTEM_PROMPT = [
  "You are Aced helping the user EXPLAIN code to an interviewer. A screenshot of the code on",
  "screen is provided, plus the running session memory. Explain the logic clearly as TELEPROMPTER",
  "CUE BULLETS the user can say out loud: start each line with '• ', short first-person sentences",
  "(e.g. 'I use a hashmap to store seen values'). Cover what the code does, the key idea, the data",
  "structures, and the time/space complexity. If the interviewer pointed at a specific line or part",
  "(see the transcript), focus there. Be accurate to the code shown; do not invent a different",
  "approach. Output ONLY the bullet lines.",
].join(" ");

export interface StreamExplainOptions {
  /** A screenshot of the current code on screen. */
  imageDataUrl: string;
  /** Running session memory for context. */
  sessionMemory?: string;
  /** Recent transcript — e.g. which line/part the interviewer asked about. */
  recentTranscript?: string;
  signal: AbortSignal;
  onDelta: (text: string) => void;
}

/**
 * Streams a spoken-style explanation of the on-screen code. Mistral first, Gemini
 * behind it — a failure on either is invisible to the user.
 */
export async function streamExplain(options: StreamExplainOptions): Promise<void> {
  const parts: string[] = [];
  if (options.sessionMemory?.trim()) {
    parts.push(`SESSION SO FAR:\n${options.sessionMemory.trim()}`);
  }
  if (options.recentTranscript?.trim()) {
    parts.push(
      `RECENT TRANSCRIPT (what was just asked):\n${options.recentTranscript.trim().slice(0, 2_000)}`,
    );
  }
  parts.push("Explain the code shown in this screenshot, as cue bullets I can say out loud.");

  await streamWithFallback({
    providers: visionProviders(),
    signal: options.signal,
    onDelta: options.onDelta,
    timeoutMs: CODING_TIMEOUT_MS,
    label: "Explain",
    buildBody: (provider) => ({
      model: provider.model,
      messages: [
        { role: "system", content: EXPLAIN_SYSTEM_PROMPT },
        {
          role: "user",
          content: userContent(provider, parts.join("\n\n"), options.imageDataUrl),
        },
      ],
      stream: true,
      // Generous: reasoning-style models charge their thinking to this budget and
      // spend it BEFORE writing anything, so a tight cap yields an empty answer.
      max_tokens: 4000,
      temperature: 0.3,
    }),
  });
}

/**
 * Coding mode: sends a screenshot of the on-screen problem (DSA, SQL/pandas, or a
 * maths/probability/reasoning question) to the vision chain and streams back the
 * solution. Mistral answers first; if it is down, rate-limited, or returns nothing,
 * Gemini takes over silently. Folds in recent transcript and the previous solution
 * so modified/follow-up questions adapt.
 */
export async function streamCodingAnswer(options: StreamCodingAnswerOptions): Promise<void> {
  await streamWithFallback({
    providers: visionProviders(),
    signal: options.signal,
    onDelta: options.onDelta,
    timeoutMs: CODING_TIMEOUT_MS,
    label: "Coding",
    buildBody: (provider) => ({
      model: provider.model,
      messages: [
        { role: "system", content: CODING_SYSTEM_PROMPT },
        {
          role: "user",
          content: userContent(provider, buildCodingUserText(options), options.imageDataUrl),
        },
      ],
      stream: true,
      // Reasoning-style models charge their thinking to this budget and spend it
      // BEFORE any visible text, so a tight cap returns an empty answer. Measured
      // need: ~1000 easy, ~2700 medium, ~3500 hard LeetCode/expected-value.
      max_tokens: 4500,
      temperature: 0.2,
    }),
  });
}

/**
 * Classifies whether `utterance` is a complete question/request (Layer 2 of the
 * turn gate). Fails OPEN (complete=true) on timeout/parse/any error — better to
 * answer than to hang the overlay. The utterance is never logged.
 */
export async function classifyTurnComplete(utterance: string): Promise<TurnCompleteResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
  try {
    const res = await fetch(GROQ_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: turnModel(),
        messages: [
          { role: "system", content: TURN_SYSTEM_PROMPT },
          { role: "user", content: utterance },
        ],
        temperature: 0,
        // gpt-oss reasons before answering and bills that against max_tokens, so the
        // old cap of 3 would return an empty string and fail open on every call. Measured
        // at 146ms median / 176ms p90 with this budget, well inside TURN_TIMEOUT_MS.
        max_tokens: 900,
        reasoning_effort: "low",
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { complete: true, source: "error" };
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const first = (data.choices?.[0]?.message?.content ?? "").trim()[0]?.toLowerCase();
    if (first === "n") return { complete: false, source: "groq" };
    if (first === "y") return { complete: true, source: "groq" };
    return { complete: true, source: "parse" };
  } catch {
    return { complete: true, source: controller.signal.aborted ? "timeout" : "error" };
  } finally {
    clearTimeout(timeout);
  }
}
