declare const sampleRate: number;

declare class AudioWorkletProcessor {
  public readonly port: MessagePort;
  public constructor(options?: AudioWorkletNodeOptions);
  public process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(name: string, processorCtor: typeof AudioWorkletProcessor): void;

interface PcmProcessorOptions {
  processorOptions?: {
    channelCount?: number;
    framesPerChunk?: number;
    targetSampleRate?: number;
  };
}

/**
 * Generic PCM tap shared by all STT providers. Pulls raw audio from its input,
 * downsamples to a target rate, converts Float32 -> Int16, interleaves the
 * configured channel count, and posts fixed-size chunks back to the main thread.
 *
 * - Deepgram uses channelCount=2 (mic on channel 0, loopback on channel 1).
 * - ElevenLabs and Sarvam use channelCount=1 (one mono connection per source).
 */
class PcmWorklet extends AudioWorkletProcessor {
  private readonly channelCount: number;
  private readonly framesPerChunk: number;
  private readonly resampleRatio: number;
  private readonly pending: number[][];
  private readonly interleavedSamples: number[] = [];
  private sourceOffset = 0;

  public constructor(options?: PcmProcessorOptions) {
    super();
    const processorOptions = options?.processorOptions;
    this.channelCount = Math.max(1, processorOptions?.channelCount ?? 1);
    this.framesPerChunk = processorOptions?.framesPerChunk ?? 320;
    const targetSampleRate = processorOptions?.targetSampleRate ?? 16000;
    this.resampleRatio = sampleRate / targetSampleRate;
    this.pending = Array.from({ length: this.channelCount }, () => []);
  }

  public override process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const firstChannel = input?.[0];
    if (!input || !firstChannel) {
      this.writeSilence(outputs);
      return true;
    }

    this.appendInput(input, firstChannel.length);
    this.emitAvailableAudio();
    this.writeSilence(outputs);
    return true;
  }

  private appendInput(input: Float32Array[], frameCount: number): void {
    for (let channel = 0; channel < this.channelCount; channel += 1) {
      const samples = input[channel] ?? input[0];
      const target = this.pending[channel];
      if (!samples || !target) continue;
      for (let i = 0; i < frameCount; i += 1) {
        target.push(samples[i] ?? 0);
      }
    }
  }

  private emitAvailableAudio(): void {
    const leadChannel = this.pending[0];
    if (!leadChannel) return;
    const chunkSampleCount = this.framesPerChunk * this.channelCount;

    while (Math.floor(this.sourceOffset) + 1 < leadChannel.length) {
      const sourceIndex = Math.floor(this.sourceOffset);
      const nextIndex = sourceIndex + 1;
      const fraction = this.sourceOffset - sourceIndex;

      for (let channel = 0; channel < this.channelCount; channel += 1) {
        const samples = this.pending[channel] ?? leadChannel;
        const value = this.interpolate(
          samples[sourceIndex] ?? 0,
          samples[nextIndex] ?? 0,
          fraction,
        );
        this.interleavedSamples.push(this.floatToInt16(value));
      }

      this.sourceOffset += this.resampleRatio;

      if (this.interleavedSamples.length >= chunkSampleCount) {
        this.flushChunk(chunkSampleCount);
      }
    }

    const consumed = Math.floor(this.sourceOffset);
    if (consumed > 0) {
      for (const channel of this.pending) {
        channel.splice(0, consumed);
      }
      this.sourceOffset -= consumed;
    }
  }

  private flushChunk(chunkSampleCount: number): void {
    const chunk = new Int16Array(chunkSampleCount);
    for (let i = 0; i < chunkSampleCount; i += 1) {
      chunk[i] = this.interleavedSamples[i] ?? 0;
    }
    this.interleavedSamples.splice(0, chunkSampleCount);
    this.port.postMessage(
      {
        type: "audio",
        buffer: chunk.buffer,
        frames: this.framesPerChunk,
      },
      [chunk.buffer],
    );
  }

  private writeSilence(outputs: Float32Array[][]): void {
    const output = outputs[0];
    if (!output) return;
    for (const channel of output) {
      channel.fill(0);
    }
  }

  private interpolate(first: number, second: number, fraction: number): number {
    return first + (second - first) * fraction;
  }

  private floatToInt16(sample: number): number {
    const clamped = Math.max(-1, Math.min(1, sample));
    return Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
  }
}

registerProcessor("pcm-worklet", PcmWorklet);
