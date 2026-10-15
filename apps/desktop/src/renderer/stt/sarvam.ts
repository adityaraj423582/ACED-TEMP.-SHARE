import type { SpeakerChannel, SttTranscriptEvent } from "@aced/shared";
import { DualMonoSttAdapter, type DualMonoAdapterOptions } from "./dual-mono-adapter.js";
import { arrayBufferToBase64, isRecord, readNumber, readString } from "./util.js";

const SARVAM_MODE = "transcribe";
const SAMPLE_RATE = "16000";

export interface SarvamSttAdapterOptions extends DualMonoAdapterOptions {
  /** Supplies the local relay URL (hosted by the Electron main process). */
  getRelayUrl?: () => Promise<string>;
}

/**
 * Sarvam saaras:v3 (mode=transcribe) implementation. Sarvam requires an
 * Api-Subscription-Key header that browser WebSockets cannot set, so we connect
 * to a local relay inside the Electron main process which injects the key.
 * One connection per source: mic ("you") and loopback ("them").
 */
export class SarvamSttAdapter extends DualMonoSttAdapter {
  protected readonly provider = "sarvam";

  public constructor(private readonly sarvamOptions: SarvamSttAdapterOptions) {
    super(sarvamOptions);
  }

  protected async openSocket(speaker: SpeakerChannel): Promise<WebSocket> {
    const socket = new WebSocket(await this.buildUrl());
    try {
      await this.waitForOpen(socket);
    } catch (err: unknown) {
      socket.close();
      throw err;
    }
    this.log(this.provider, `${speaker} WebSocket connected via proxy (saaras:v3 ${SARVAM_MODE})`);
    return socket;
  }

  protected encodeChunk(pcm: ArrayBuffer): string {
    return JSON.stringify({
      audio: {
        data: arrayBufferToBase64(pcm),
        sample_rate: SAMPLE_RATE,
        encoding: "pcm_s16le",
      },
    });
  }

  protected override closeFrame(): string {
    return JSON.stringify({ type: "flush" });
  }

  protected parseMessage(speaker: SpeakerChannel, data: string): SttTranscriptEvent | null {
    const payload: unknown = JSON.parse(data);
    if (!isRecord(payload)) return null;

    const type = readString(payload, "type");
    const body = payload.data;

    if (type === "error") {
      const message = isRecord(body) ? readString(body, "error") : undefined;
      this.log(`${this.provider} error`, `${speaker}: ${message ?? data}`);
      return null;
    }

    if (type !== "data" || !isRecord(body)) return null;

    const transcript = readString(body, "transcript")?.trim();
    if (!transcript) return null;

    return {
      provider: this.provider,
      speaker,
      transcript,
      // Sarvam emits a result per detected utterance — treat each as final.
      isFinal: true,
      durationSeconds: isRecord(body.metrics)
        ? readNumber(body.metrics, "audio_duration")
        : undefined,
    };
  }

  private async buildUrl(): Promise<string> {
    if (!this.sarvamOptions.getRelayUrl) {
      throw new Error("Sarvam adapter was constructed without a relay URL supplier");
    }
    const url = new URL(await this.sarvamOptions.getRelayUrl());
    url.searchParams.set("mode", SARVAM_MODE);
    return url.toString();
  }
}
