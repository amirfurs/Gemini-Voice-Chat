import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { logger } from "../lib/logger";

const GEMINI_LIVE_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export interface GeminiLiveEvents {
  audio: (pcmData: Buffer) => void;
  text: (text: string) => void;
  error: (err: Error) => void;
  close: () => void;
}

export class GeminiLiveSession extends EventEmitter {
  private ws: WebSocket | null = null;
  private apiKey: string;
  private isSetup = false;

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${GEMINI_LIVE_URL}?key=${this.apiKey}`;
      this.ws = new WebSocket(url);

      this.ws.on("open", () => {
        logger.info("Gemini Live WebSocket connected");
        this.sendSetup();
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg, resolve);
        } catch (err) {
          logger.error({ err }, "Failed to parse Gemini message");
        }
      });

      this.ws.on("error", (err) => {
        logger.error({ err }, "Gemini Live WebSocket error");
        this.emit("error", err);
        reject(err);
      });

      this.ws.on("close", () => {
        logger.info("Gemini Live WebSocket closed");
        this.emit("close");
      });
    });
  }

  private sendSetup() {
    const setupMsg = {
      setup: {
        model: "models/gemini-2.0-flash-live-001",
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: "Aoede",
              },
            },
          },
        },
        systemInstruction: {
          parts: [
            {
              text: "You are a helpful, friendly voice assistant in a Discord voice channel. Keep responses concise and conversational. Speak naturally.",
            },
          ],
        },
      },
    };
    this.ws?.send(JSON.stringify(setupMsg));
  }

  private handleMessage(msg: Record<string, unknown>, setupResolve?: (v: void) => void) {
    if (msg.setupComplete && setupResolve) {
      logger.info("Gemini Live session setup complete");
      this.isSetup = true;
      setupResolve();
      return;
    }

    if (msg.serverContent) {
      const content = msg.serverContent as Record<string, unknown>;

      if (content.modelTurn) {
        const turn = content.modelTurn as Record<string, unknown>;
        const parts = turn.parts as Array<Record<string, unknown>> | undefined;
        if (parts) {
          for (const part of parts) {
            if (part.inlineData) {
              const inlineData = part.inlineData as Record<string, unknown>;
              if (inlineData.mimeType === "audio/pcm;rate=24000") {
                const audioData = Buffer.from(inlineData.data as string, "base64");
                this.emit("audio", audioData);
              }
            }
            if (part.text) {
              this.emit("text", part.text as string);
            }
          }
        }
      }
    }
  }

  sendAudio(pcmData: Buffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isSetup) return;

    const msg = {
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: "audio/pcm;rate=48000",
            data: pcmData.toString("base64"),
          },
        ],
      },
    };
    this.ws.send(JSON.stringify(msg));
  }

  sendText(text: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isSetup) return;

    const msg = {
      clientContent: {
        turns: [
          {
            role: "user",
            parts: [{ text }],
          },
        ],
        turnComplete: true,
      },
    };
    this.ws.send(JSON.stringify(msg));
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }
}
