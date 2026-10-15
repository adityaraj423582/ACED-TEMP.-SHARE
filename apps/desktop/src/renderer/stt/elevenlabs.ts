import type { SpeakerChannel, SttTranscriptEvent } from "@aced/shared";
import { DualMonoSttAdapter, type DualMonoAdapterOptions } from "./dual-mono-adapter.js";
import { arrayBufferToBase64, isRecord, readString } from "./util.js";

const ELEVENLABS_REALTIME_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const ELEVENLABS_MODEL = "scribe_v2_realtime";

export interface ElevenLabsSttAdapterOptions extends DualMonoAdapterOptions {
  /** Supplies a single-use token (minted by the Electron main process). */
  getToken?: () => Promise<string>;
}

/**
 * ElevenLabs Scribe v2 Realtime implementation. Scribe streams one source per
 * connection, so we open two: mic ("you") and loopback ("them"). Each connection
 * authenticates with its own single-use token minted by the main process.
 */
export class ElevenLabsSttAdapter extends DualMonoSttAdapter {
  protected readonly provider = "elevenlabs";

  public constructor(private readonly elevenLabsOptions: ElevenLabsSttAdapterOptions) {
    super(elevenLabsOptions);
  }

  protected async openSocket(speaker: SpeakerChannel): Promise<WebSocket> {
    const token = await this.fetchToken(speaker);
    const socket = new WebSocket(this.buildUrl(token));
    try {
      await this.waitForOpen(socket);
    } catch (err: unknown) {
      socket.close();
      throw err;
    }
    this.log(this.provider, `${speaker} WebSocket connected (${ELEVENLABS_MODEL})`);
    return socket;
  }

  protected encodeChunk(pcm: ArrayBuffer): string {
    return JSON.stringify({
      message_type: "input_audio_chunk",
      audio_base_64: arrayBufferToBase64(pcm),
    });
  }

  protected parseMessage(speaker: SpeakerChannel, data: string): SttTranscriptEvent | null {
    const payload: unknown = JSON.parse(data);
    if (!isRecord(payload)) return null;

    const messageType = readString(payload, "message_type");
    if (messageType === "session_started") {
      this.log(this.provider, `${speaker} session started`);
      return null;
    }

    const isPartial = messageType === "partial_transcript";
    const isFinal = messageType === "committed_transcript";
    if (!isPartial && !isFinal) {
      const error = readString(payload, "error");
      if (error) this.log(`${this.provider} error`, `${speaker}: ${error}`);
      return null;
    }

    const transcript = readString(payload, "text")?.trim();
    if (!transcript) return null;

    return { provider: this.provider, speaker, transcript, isFinal };
  }

  private buildUrl(token: string): string {
    const url = new URL(ELEVENLABS_REALTIME_URL);
    url.searchParams.set("model_id", ELEVENLABS_MODEL);
    url.searchParams.set("audio_format", "pcm_16000");
    url.searchParams.set("commit_strategy", "vad");
    url.searchParams.set("token", token);
    return url.toString();
  }

  private async fetchToken(speaker: SpeakerChannel): Promise<string> {
    if (!this.elevenLabsOptions.getToken) {
      throw new Error("ElevenLabs adapter was constructed without a token supplier");
    }
    this.log(this.provider, `requesting single-use token for ${speaker} via main process`);
    return this.elevenLabsOptions.getToken();
  }
}
