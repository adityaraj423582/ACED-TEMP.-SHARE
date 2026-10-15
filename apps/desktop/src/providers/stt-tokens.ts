/**
 * Short-lived STT credentials minted directly by the Electron main process.
 * The long-lived provider API keys live only in the main process and never reach the
 * renderer — only ephemeral tokens cross the IPC boundary.
 */

const DEEPGRAM_GRANT_URL = "https://api.deepgram.com/v1/auth/grant";
const ELEVENLABS_TOKEN_URL = "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe";

export class SttTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SttTokenError";
  }
}

function requireKey(name: "DEEPGRAM_API_KEY" | "ELEVENLABS_API_KEY"): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new SttTokenError(`${name} is missing. Click Keys and add it.`);
  }
  return value;
}

export interface SttTokenGrant {
  accessToken: string;
  expiresInSeconds?: number;
}

/**
 * Mints a short-lived Deepgram JWT for the renderer's WebSocket.
 *
 * TTL is 300s rather than 30s: on a slow link the grant itself can take >1.5s and the
 * handshake another >1s, and a retry reuses none of that budget — a 30s window left
 * almost no headroom before the token expired mid-dial. The token still never leaves
 * this machine and is only used to open one socket.
 */
export async function mintDeepgramToken(): Promise<SttTokenGrant> {
  const res = await fetch(DEEPGRAM_GRANT_URL, {
    method: "POST",
    headers: {
      Authorization: `Token ${requireKey("DEEPGRAM_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ttl_seconds: 300 }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new SttTokenError(
      `Deepgram token request failed (HTTP ${res.status}). ${detail.slice(0, 160)}`,
    );
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new SttTokenError("Deepgram token response had no access_token.");
  }
  return { accessToken: data.access_token, expiresInSeconds: data.expires_in };
}

/** Mints a single-use ElevenLabs Scribe realtime token (15-minute TTL). */
export async function mintElevenLabsToken(): Promise<SttTokenGrant> {
  const res = await fetch(ELEVENLABS_TOKEN_URL, {
    method: "POST",
    headers: { "xi-api-key": requireKey("ELEVENLABS_API_KEY") },
  });
  if (!res.ok) {
    throw new SttTokenError(`ElevenLabs token request failed (HTTP ${res.status}).`);
  }
  const data = (await res.json()) as { token?: string };
  if (!data.token) {
    throw new SttTokenError("ElevenLabs token response had no token.");
  }
  return { accessToken: data.token, expiresInSeconds: 15 * 60 };
}
