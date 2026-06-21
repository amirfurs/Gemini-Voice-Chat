import {
  VoiceConnection,
  createAudioResource,
  createAudioPlayer,
  AudioPlayerStatus,
  StreamType,
  EndBehaviorType,
} from "@discordjs/voice";
import { Readable } from "node:stream";
import { GeminiSession } from "./gemini-session";
import { logger } from "../lib/logger";

// prism-media is CJS — load via require (available from build banner)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prism: any = (globalThis as any).require("prism-media");

const OPUS_SAMPLE_RATE = 48000;
const OPUS_CHANNELS = 2;

export class VoiceSession {
  private connection: VoiceConnection;
  private gemini: GeminiSession;
  private activeUsers = new Set<string>();
  private player = createAudioPlayer();
  private audioQueue: Readable[] = [];
  private isPlaying = false;

  constructor(connection: VoiceConnection, gemini: GeminiSession) {
    this.connection = connection;
    this.gemini = gemini;

    gemini.on("audioStream", (stream: Readable) => {
      this.audioQueue.push(stream);
      if (!this.isPlaying) this.playNext();
    });

    gemini.on("text", (text: string) => {
      logger.info({ text }, "Gemini response");
    });

    gemini.on("error", (err: Error) => {
      logger.error({ err }, "Gemini session error");
    });

    this.player.on(AudioPlayerStatus.Idle, () => {
      this.isPlaying = false;
      this.playNext();
    });

    this.player.on("error", (err) => {
      logger.error({ err }, "Audio player error");
      this.isPlaying = false;
      this.playNext();
    });

    this.connection.subscribe(this.player);
    this.startListening();
  }

  private playNext() {
    const stream = this.audioQueue.shift();
    if (!stream) return;
    this.isPlaying = true;
    const resource = createAudioResource(stream, {
      inputType: StreamType.Arbitrary,
    });
    this.player.play(resource);
  }

  private startListening() {
    const receiver = this.connection.receiver;

    receiver.speaking.on("start", (userId: string) => {
      if (this.activeUsers.has(userId)) return;
      this.activeUsers.add(userId);
      logger.info({ userId }, "User started speaking");

      const opusStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 800 },
      });

      // Decode Opus → s16le PCM via prism-media
      const decoder = new prism.opus.Decoder({
        rate: OPUS_SAMPLE_RATE,
        channels: OPUS_CHANNELS,
        frameSize: 960,
      });

      const pcmChunks: Buffer[] = [];

      opusStream.pipe(decoder);

      decoder.on("data", (chunk: Buffer) => {
        pcmChunks.push(chunk);
      });

      decoder.on("end", async () => {
        this.activeUsers.delete(userId);
        logger.info({ userId, chunks: pcmChunks.length }, "User stopped speaking");

        if (pcmChunks.length === 0) return;
        const pcm = Buffer.concat(pcmChunks);
        await this.gemini.processPcm(pcm, OPUS_SAMPLE_RATE, OPUS_CHANNELS);
      });

      decoder.on("error", (err: Error) => {
        logger.error({ err, userId }, "Decoder error");
        this.activeUsers.delete(userId);
      });

      opusStream.on("error", (err: Error) => {
        logger.error({ err, userId }, "Opus stream error");
        this.activeUsers.delete(userId);
      });
    });
  }

  async introduce(): Promise<void> {
    await this.gemini.introduce();
  }

  async askText(text: string): Promise<void> {
    await this.gemini.sendText(text);
  }

  destroy() {
    this.audioQueue = [];
    this.player.stop();
    this.gemini.close();
    this.connection.destroy();
  }
}
