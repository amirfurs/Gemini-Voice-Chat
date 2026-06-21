import {
  VoiceConnection,
  createAudioResource,
  createAudioPlayer,
  AudioPlayerStatus,
  StreamType,
  EndBehaviorType,
} from "@discordjs/voice";
import { Readable } from "node:stream";
import { GeminiLiveSession } from "./gemini-live";
import { logger } from "../lib/logger";

export class VoiceSession {
  private connection: VoiceConnection;
  private gemini: GeminiLiveSession;
  private activeUsers = new Set<string>();
  private audioBuffer: Buffer[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private player = createAudioPlayer();
  private isPlaying = false;
  private pendingAudio: Buffer[] = [];

  constructor(connection: VoiceConnection, gemini: GeminiLiveSession) {
    this.connection = connection;
    this.gemini = gemini;

    gemini.on("audio", (pcmData: Buffer) => {
      this.pendingAudio.push(pcmData);
      if (!this.isPlaying) {
        this.flushPendingAudio();
      }
    });

    gemini.on("text", (text: string) => {
      logger.info({ text }, "Gemini text response");
    });

    gemini.on("error", (err: Error) => {
      logger.error({ err }, "Gemini error in voice session");
    });

    this.player.on(AudioPlayerStatus.Idle, () => {
      this.isPlaying = false;
      if (this.pendingAudio.length > 0) {
        this.flushPendingAudio();
      }
    });

    this.player.on("error", (err) => {
      logger.error({ err }, "Audio player error");
      this.isPlaying = false;
    });

    this.connection.subscribe(this.player);
    this.startListening();
  }

  private flushPendingAudio() {
    if (this.pendingAudio.length === 0) return;
    const combined = Buffer.concat(this.pendingAudio);
    this.pendingAudio = [];
    this.playPcm(combined);
  }

  private playPcm(pcm: Buffer) {
    if (pcm.length === 0) return;
    this.isPlaying = true;

    const readable = new Readable({
      read() {},
    });

    const chunkSize = 4096;
    for (let i = 0; i < pcm.length; i += chunkSize) {
      readable.push(pcm.slice(i, i + chunkSize));
    }
    readable.push(null);

    const resource = createAudioResource(readable, {
      inputType: StreamType.Raw,
    });

    this.player.play(resource);
  }

  private startListening() {
    const receiver = this.connection.receiver;

    receiver.speaking.on("start", (userId: string) => {
      if (this.activeUsers.has(userId)) return;
      this.activeUsers.add(userId);

      logger.info({ userId }, "User started speaking, subscribing to audio");

      const stream = receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: 500,
        },
      });

      stream.on("data", (chunk: Buffer) => {
        this.audioBuffer.push(chunk);
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flushTimer = setTimeout(() => {
          this.flushAudioToGemini();
        }, 250);
      });

      stream.on("end", () => {
        this.activeUsers.delete(userId);
        logger.info({ userId }, "User stopped speaking");
        if (this.audioBuffer.length > 0) {
          if (this.flushTimer) clearTimeout(this.flushTimer);
          this.flushAudioToGemini();
        }
      });

      stream.on("error", (err) => {
        logger.error({ err, userId }, "Audio receive stream error");
        this.activeUsers.delete(userId);
      });
    });
  }

  private flushAudioToGemini() {
    if (this.audioBuffer.length === 0) return;
    const combined = Buffer.concat(this.audioBuffer);
    this.audioBuffer = [];
    logger.info({ bytes: combined.length }, "Sending audio to Gemini");
    this.gemini.sendAudio(combined);
  }

  destroy() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.activeUsers.clear();
    this.player.stop();
    this.gemini.close();
    this.connection.destroy();
  }
}
