import type { SpeechToTextAdapter, SttProvider } from "@aced/shared";
import {
  type DeepgramTokenGrant,
  DeepgramSttAdapter,
  type SttConnectionStatus,
} from "./deepgram.js";
import { ElevenLabsSttAdapter } from "./elevenlabs.js";
import { SarvamSttAdapter } from "./sarvam.js";

/** Construction options common to every STT adapter. */
export interface SttAdapterOptions {
  micStream: MediaStream;
  systemAudioStream: MediaStream;
  /** Supplies a short-lived Deepgram token (minted by the main process). */
  getDeepgramToken?: () => Promise<DeepgramTokenGrant>;
  /** Supplies a single-use ElevenLabs token (minted by the main process). */
  getElevenLabsToken?: () => Promise<string>;
  /** Supplies the local Sarvam relay WebSocket URL (started by the main process). */
  getSarvamRelayUrl?: () => Promise<string>;
  onLog?: (label: string, value: string) => void;
  /** Connection drop/recovery notifications (Deepgram only for now). */
  onStatus?: (status: SttConnectionStatus) => void;
  /** Label speakers (Deepgram only). Set in Phone mode, where one mic carries both. */
  diarize?: boolean;
}

/** Builds the STT adapter for the selected provider behind one shared contract. */
export function createSttAdapter(
  provider: SttProvider,
  options: SttAdapterOptions,
): SpeechToTextAdapter {
  switch (provider) {
    case "elevenlabs":
      return new ElevenLabsSttAdapter({ ...options, getToken: options.getElevenLabsToken });
    case "sarvam":
      return new SarvamSttAdapter({ ...options, getRelayUrl: options.getSarvamRelayUrl });
    case "deepgram":
      return new DeepgramSttAdapter({ ...options, getToken: options.getDeepgramToken });
    default:
      return assertNever(provider);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported STT provider: ${String(value)}`);
}
