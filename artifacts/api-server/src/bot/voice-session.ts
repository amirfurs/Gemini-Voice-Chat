import {
  VoiceConnection,
  AudioReceiveStream,
  getVoiceConnection,
  createAudioResource,
  createAudioPlayer,
  AudioPlayerStatus,
  StreamType,
  VoiceConnectionStatus,
  entersState,
} from "@discordjs/voice";
import { VoiceChannel, GuildMember } from "discord.js";
import { Readable } from "node:stream";
import { GeminiLiveSession } from "./gemini-live";
import { logger } from "../lib/logger";

export class VoiceSession {
  private connection: VoiceConnection;
  private gemini: GeminiLiveSession;
  private activeStreams = new Map<string, AudioReceiveStream>();
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
    this.isPlaying = true;
    // Gemini returns 24kHz mono s16le PCM — wrap it in a readable stream
    const readable = Readable.from(
      (function* () {
        const chunkSize = 4096;
        for (let i = 0; i < pcm.length; i += chunkSize) {
          yield pcm.slice(i, i + chunkSize);
        }
      })()
    );

    const resource = createAudioResource(readable, {
      inputType: StreamType.Raw,
    });

    this.player.play(resource);
  }

  private startListening() {
    const receiver = this.connection.receiver;

    receiver.speaking.on("start", (userId: string) => {
      if (this.activeStreams.has(userId)) return;

      logger.info({ userId }, "User started speaking");

      const stream = receiver.subscribe(userId, {
        end: { behavior: 2 as const, duration: 500 },
      });

      this.activeStreams.set(userId, stream);

      stream.on("data", (chunk: Buffer) => {
        this.audioBuffer.push(chunk);
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flushTimer = setTimeout(() => {
          this.flushAudioToGemini();
        }, 300);
      });

      stream.on("end", () => {
        this.activeStreams.delete(userId);
        if (this.audioBuffer.length > 0) {
          this.flushAudioToGemini();
        }
      });
    });
  }

  private flushAudioToGemini() {
    if (this.audioBuffer.length === 0) return;
    const combined = Buffer.concat(this.audioBuffer);
    this.audioBuffer = [];
    this.gemini.sendAudio(combined);
  }

  destroy() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.activeStreams.clear();
    this.player.stop();
    this.gemini.close();
    this.connection.destroy();
  }
}
