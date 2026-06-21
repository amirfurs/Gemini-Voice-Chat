import { GoogleGenAI } from "@google/genai";
import { EventEmitter } from "node:events";
import { logger } from "../lib/logger";

export class GeminiLiveSession extends EventEmitter {
  private session: Awaited<ReturnType<GoogleGenAI["live"]["connect"]>> | null = null;
  isSetup = false;

  async connect(apiKey: string): Promise<void> {
    const ai = new GoogleGenAI({ apiKey });

    return new Promise((resolve, reject) => {
      ai.live
        .connect({
          model: "gemini-2.0-flash-live-001",
          config: {
            responseModalities: ["AUDIO"] as never,
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: "Aoede" },
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
          callbacks: {
            onopen: () => {
              logger.info("Gemini Live session opened");
              this.isSetup = true;
              resolve();
            },
            onmessage: (msg: Record<string, unknown>) => {
              this.handleMessage(msg);
            },
            onerror: (e: ErrorEvent) => {
              logger.error({ err: e.message }, "Gemini Live error");
              this.emit("error", new Error(e.message ?? "Gemini Live error"));
              reject(new Error(e.message ?? "Gemini Live error"));
            },
            onclose: (e: CloseEvent) => {
              logger.warn({ code: e.code, reason: e.reason }, "Gemini Live closed");
              this.emit("close");
              if (!this.isSetup) {
                reject(
                  new Error(
                    `Gemini Live closed before ready (code=${e.code} reason=${e.reason ?? "none"})`
                  )
                );
              }
            },
          },
        })
        .then((s) => {
          this.session = s;
        })
        .catch((err: Error) => {
          logger.error({ err }, "Failed to connect to Gemini Live");
          reject(err);
        });
    });
  }

  private handleMessage(msg: Record<string, unknown>) {
    try {
      const serverContent = msg.serverContent as Record<string, unknown> | undefined;
      if (!serverContent) return;

      const modelTurn = serverContent.modelTurn as Record<string, unknown> | undefined;
      if (!modelTurn) return;

      const parts = modelTurn.parts as Array<Record<string, unknown>> | undefined;
      if (!parts) return;

      for (const part of parts) {
        if (part.inlineData) {
          const inlineData = part.inlineData as Record<string, unknown>;
          const data = Buffer.from(inlineData.data as string, "base64");
          this.emit("audio", data);
        }
        if (part.text) {
          this.emit("text", part.text as string);
        }
      }
    } catch (err) {
      logger.error({ err }, "Error handling Gemini message");
    }
  }

  sendAudio(pcmData: Buffer) {
    if (!this.session || !this.isSetup) return;
    try {
      this.session.sendRealtimeInput({
        media: {
          mimeType: "audio/pcm;rate=48000",
          data: pcmData.toString("base64"),
        } as never,
      });
    } catch (err) {
      logger.error({ err }, "Failed to send audio to Gemini");
    }
  }

  sendText(text: string) {
    if (!this.session || !this.isSetup) return;
    try {
      this.session.sendClientContent({
        turns: [{ role: "user", parts: [{ text }] }] as never,
        turnComplete: true,
      });
    } catch (err) {
      logger.error({ err }, "Failed to send text to Gemini");
    }
  }

  close() {
    try {
      this.session?.close();
    } catch (_) {}
    this.session = null;
    this.isSetup = false;
  }
}
