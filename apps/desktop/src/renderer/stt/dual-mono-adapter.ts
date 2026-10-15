import type {
  SpeakerChannel,
  SpeechToTextAdapter,
  SttTranscriptEvent,
  SttTranscriptHandler,
} from "@aced/shared";
import { MonoPcmSource } from "./mono-pcm-source.js";
import { getErrorMessage } from "./util.js";

const TARGET_SAMPLE_RATE = 16000;
const FRAMES_PER_CHUNK = 320;
const OPEN_TIMEOUT_MS = 10000;

/** Shared construction options for the mono (two-connection) STT adapters. */
export interface DualMonoAdapterOptions {
  micStream: MediaStream;
  systemAudioStream: MediaStream;
  onLog?: (label: string, value: string) => void;
}

interface MonoConnection {
  speaker: SpeakerChannel;
  socket: WebSocket;
  source: MonoPcmSource;
}

/**
 * Base class for providers that transcribe one audio source per WebSocket.
 * It runs two connections — mic ("you") and loopback ("them") — and labels each
 * transcript by connection. Subclasses supply the provider-specific socket,
 * audio frame encoding, and response parsing.
 */
export abstract class DualMonoSttAdapter implements SpeechToTextAdapter {
  protected abstract readonly provider: string;

  private readonly partialHandlers = new Set<SttTranscriptHandler>();
  private readonly finalHandlers = new Set<SttTranscriptHandler>();
  private readonly connections: MonoConnection[] = [];
  private isStarted = false;

  public constructor(protected readonly options: DualMonoAdapterOptions) {}

  /** Opens the provider WebSocket for one speaker and resolves once it is OPEN. */
  protected abstract openSocket(speaker: SpeakerChannel): Promise<WebSocket>;

  /** Encodes one PCM chunk into the text frame the provider expects. */
  protected abstract encodeChunk(pcm: ArrayBuffer): string;

  /** Parses one provider message into a transcript event, or null to ignore it. */
  protected abstract parseMessage(speaker: SpeakerChannel, data: string): SttTranscriptEvent | null;

  /** Optional control frame (e.g. a flush) to send before closing each socket. */
  protected closeFrame(): string | null {
    return null;
  }

  public async start(): Promise<void> {
    if (this.isStarted) return;
    this.isStarted = true;

    try {
      await this.startConnection("you", this.options.micStream);
      await this.startConnection("them", this.options.systemAudioStream);
      this.log(this.provider, `streaming 2 mono connections @ ${TARGET_SAMPLE_RATE} Hz linear16`);
    } catch (err: unknown) {
      await this.stop();
      throw err;
    }
  }

  public onPartial(handler: SttTranscriptHandler): () => void {
    this.partialHandlers.add(handler);
    return () => this.partialHandlers.delete(handler);
  }

  public onFinal(handler: SttTranscriptHandler): () => void {
    this.finalHandlers.add(handler);
    return () => this.finalHandlers.delete(handler);
  }

  public async stop(): Promise<void> {
    this.isStarted = false;

    const connections = this.connections.splice(0, this.connections.length);
    await Promise.all(
      connections.map(async ({ socket, source }) => {
        await source.stop();
        socket.onmessage = null;
        if (socket.readyState === WebSocket.OPEN) {
          const frame = this.closeFrame();
          if (frame) socket.send(frame);
          socket.close(1000, "Aced stopped");
        } else if (socket.readyState === WebSocket.CONNECTING) {
          socket.close(1000, "Aced stopped");
        }
      }),
    );
  }

  /** Waits for a freshly created socket to reach OPEN, or rejects on failure/timeout. */
  protected waitForOpen(socket: WebSocket): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        cleanup();
        reject(new Error(`${this.provider} WebSocket open timed out`));
      }, OPEN_TIMEOUT_MS);

      const cleanup = (): void => {
        window.clearTimeout(timeoutId);
        socket.removeEventListener("open", handleOpen);
        socket.removeEventListener("error", handleError);
        socket.removeEventListener("close", handleClose);
      };
      const handleOpen = (): void => {
        cleanup();
        resolve();
      };
      const handleError = (): void => {
        cleanup();
        reject(new Error(`${this.provider} WebSocket failed to open`));
      };
      const handleClose = (): void => {
        cleanup();
        reject(new Error(`${this.provider} WebSocket closed before opening`));
      };

      socket.addEventListener("open", handleOpen);
      socket.addEventListener("error", handleError);
      socket.addEventListener("close", handleClose);
    });
  }

  protected log(label: string, value: string): void {
    this.options.onLog?.(label, value);
  }

  private async startConnection(speaker: SpeakerChannel, stream: MediaStream): Promise<void> {
    const socket = await this.openSocket(speaker);
    socket.binaryType = "arraybuffer";

    socket.addEventListener("message", (event: MessageEvent<unknown>) => {
      this.handleMessage(speaker, event.data);
    });
    socket.addEventListener("close", (event) => {
      this.log(
        this.provider,
        `${speaker} WebSocket closed code=${event.code} reason=${event.reason || "none"}`,
      );
    });
    socket.addEventListener("error", () => {
      this.log(`${this.provider} error`, `${speaker} WebSocket error`);
    });

    const source = new MonoPcmSource({
      stream,
      targetSampleRate: TARGET_SAMPLE_RATE,
      framesPerChunk: FRAMES_PER_CHUNK,
      onChunk: (pcm) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(this.encodeChunk(pcm));
        }
      },
      onError: (message) => this.log(`${this.provider} error`, `${speaker}: ${message}`),
    });
    await source.start();

    this.connections.push({ speaker, socket, source });
  }

  private handleMessage(speaker: SpeakerChannel, data: unknown): void {
    if (typeof data !== "string") return;

    let event: SttTranscriptEvent | null;
    try {
      event = this.parseMessage(speaker, data);
    } catch (err: unknown) {
      this.log(`${this.provider} error`, `failed to parse message: ${getErrorMessage(err)}`);
      return;
    }
    if (!event) return;

    const handlers = event.isFinal ? this.finalHandlers : this.partialHandlers;
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (err: unknown) {
        this.log(`${this.provider} handler error`, getErrorMessage(err));
      }
    }
  }
}
