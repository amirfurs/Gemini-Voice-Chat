import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { logger } from "../lib/logger";

const GEMINI_LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent";

export class GeminiLiveSession extends EventEmitter {
  private ws: WebSocket | null = null;
  private apiKey: string;
  isSetup = false;

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${GEMINI_LIVE_URL}?key=${this.apiKey}`;
      this.ws = new WebSocket(url);

      let settled = false;

      const doReject = (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      const doResolve = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      this.ws.on("open", () => {
        logger.info("Gemini Live WebSocket connected");
        this.sendSetup();
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg, doResolve);
        } catch (err) {
          logger.error({ err }, "Failed to parse Gemini message");
        }
      });

      this.ws.on("error", (err) => {
        logger.error({ err }, "Gemini Live WebSocket error");
        this.emit("error", err);
        doReject(err as Error);
      });

      this.ws.on("close", (code: number, reason: Buffer) => {
        const reasonStr = reason.toString();
        logger.warn({ code, reason: reasonStr }, "Gemini Live WebSocket closed");
        this.emit("close");
        doReject(new Error(`Gemini WebSocket closed before setup (code=${code} reason=${reasonStr || "none"})`));
      });
    });
  }

  private sendSetup() {
    const setupMsg = {
      setup: {
        model: "models/gemini-2.0-flash-exp",
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

  private handleMessage(msg: Record<string, unknown>, setupResolve: () => void) {
    if (msg.setupComplete) {
      logger.info("Gemini Live session setup complete");
      this.isSetup = true;
      setupResolve();
      return;
    }

    if (msg.error) {
      logger.error({ geminiError: msg.error }, "Gemini Live API error message");
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
              const audioData = Buffer.from(inlineData.data as string, "base64");
              this.emit("audio", audioData);
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
