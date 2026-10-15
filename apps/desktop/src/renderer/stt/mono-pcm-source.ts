import { isRecord } from "./util.js";

const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_FRAMES_PER_CHUNK = 320;

interface PcmWorkletMessage {
  type: "audio";
  buffer: ArrayBuffer;
  frames: number;
}

function isPcmWorkletMessage(value: unknown): value is PcmWorkletMessage {
  return (
    isRecord(value) &&
    value.type === "audio" &&
    value.buffer instanceof ArrayBuffer &&
    typeof value.frames === "number"
  );
}

function disconnectNode(node: AudioNode | null): void {
  try {
    node?.disconnect();
  } catch {
    // Already disconnected.
  }
}

export interface MonoPcmSourceOptions {
  /** Single-source MediaStream (mic or loopback) to tap as mono PCM. */
  stream: MediaStream;
  /** Receives one chunk of interleaved Int16 little-endian PCM at the target rate. */
  onChunk: (pcm: ArrayBuffer) => void;
  /** Optional error sink for audio-graph failures. */
  onError?: (message: string) => void;
  targetSampleRate?: number;
  framesPerChunk?: number;
}

/**
 * Wraps a single MediaStream in a mono PCM pipeline using the shared pcm-worklet.
 * ElevenLabs and Sarvam both transcribe one source per WebSocket, so each
 * connection owns one of these. Deepgram has its own 2-channel graph.
 */
export class MonoPcmSource {
  private audioContext: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private silentGain: GainNode | null = null;

  public constructor(private readonly options: MonoPcmSourceOptions) {}

  public async start(): Promise<void> {
    const targetSampleRate = this.options.targetSampleRate ?? DEFAULT_SAMPLE_RATE;
    const framesPerChunk = this.options.framesPerChunk ?? DEFAULT_FRAMES_PER_CHUNK;

    const audioContext = new AudioContext();
    this.audioContext = audioContext;

    await audioContext.audioWorklet.addModule(new URL("./pcm-worklet.js", import.meta.url));

    this.source = audioContext.createMediaStreamSource(this.options.stream);
    this.worklet = new AudioWorkletNode(audioContext, "pcm-worklet", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
      outputChannelCount: [1],
      processorOptions: {
        channelCount: 1,
        framesPerChunk,
        targetSampleRate,
      },
    });
    this.silentGain = audioContext.createGain();
    this.silentGain.gain.value = 0;

    this.worklet.port.onmessage = (event: MessageEvent<unknown>) => {
      if (isPcmWorkletMessage(event.data) && event.data.buffer.byteLength > 0) {
        this.options.onChunk(event.data.buffer);
      }
    };
    this.worklet.port.onmessageerror = () => {
      this.options.onError?.("AudioWorklet message error");
    };

    this.source.connect(this.worklet);
    this.worklet.connect(this.silentGain);
    this.silentGain.connect(audioContext.destination);

    await audioContext.resume();
  }

  public async stop(): Promise<void> {
    const worklet = this.worklet;
    this.worklet = null;
    if (worklet) {
      worklet.port.onmessage = null;
      worklet.port.close();
      disconnectNode(worklet);
    }

    disconnectNode(this.silentGain);
    disconnectNode(this.source);
    this.silentGain = null;
    this.source = null;

    const audioContext = this.audioContext;
    this.audioContext = null;
    if (audioContext && audioContext.state !== "closed") {
      await audioContext.close();
    }
  }
}
