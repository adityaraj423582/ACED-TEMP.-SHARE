/** Human-readable application name, shown in the overlay and logs. */
export const APP_NAME = "Aced";

/**
 * Names of the environment variables the server (apps/api) reads to talk to the
 * speech-to-text providers. These keys are server-side only and must never be
 * exposed to the desktop renderer.
 */
export const ENV_KEYS = ["DEEPGRAM_API_KEY", "ELEVENLABS_API_KEY", "SARVAM_API_KEY"] as const;

/** Union of the supported server-side environment variable names. */
export type EnvKey = (typeof ENV_KEYS)[number];

/** Speech-to-text providers Aced can stream to behind one adapter contract. */
export const STT_PROVIDERS = ["deepgram", "elevenlabs", "sarvam"] as const;

/** Union of the supported speech-to-text provider names. */
export type SttProvider = (typeof STT_PROVIDERS)[number];

/** Provider used when STT_PROVIDER is unset or unrecognized. */
export const DEFAULT_STT_PROVIDER: SttProvider = "deepgram";

/**
 * Resolves the STT_PROVIDER environment value to a known provider, falling back
 * to {@link DEFAULT_STT_PROVIDER} for missing or unrecognized values.
 */
export function parseSttProvider(value: string | undefined): SttProvider {
  const normalized = value?.trim().toLowerCase();
  return STT_PROVIDERS.includes(normalized as SttProvider)
    ? (normalized as SttProvider)
    : DEFAULT_STT_PROVIDER;
}
