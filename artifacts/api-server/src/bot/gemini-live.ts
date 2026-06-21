import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { logger } from "../lib/logger";

const WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage";

// Models and API versions to attempt, in priority order
const CANDIDATES = [
  { apiVersion: "v1alpha", model: "models/gemini-2.0-flash-live-001" },
  { apiVersion: "v1beta",  model: "models/gemini-live-2.5-flash-preview" },
  { apiVersion: "v1alpha", model: "models/gemini-live-2.5-flash-preview" },
];

export class GeminiLiveSession extends EventEmitter {
  private ws: WebSocket | null = null;
  isSetup = false;

  connect(apiKey: string): Promise<void> {
    return this.tryConnect(apiKey, 0);
  }

  private tryConnect(apiKey: string, idx: number): Promise<void> {
    if (idx >= CANDIDATES.length) {
      return Promise.reject(
        new Error(
          "No Gemini Live model/version combination worked. " +
          "Verify your API key has Live API access at aistudio.google.com."
        )
      );
    }

    const { apiVersion, model } = CANDIDATES[idx]!;
    const url = `${WS_BASE}.${apiVersion}.GenerativeService.BidiGenerateContent?key=${apiKey}`;

    logger.info({ apiVersion, model }, "Attempting Gemini Live connection");

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;

      let settled = false;

      const fail = (err: Error) => {
        if (!settled) { settled = true; reject(err); }
      };

      ws.on("open", () => {
        logger.info({ apiVersion, model }, "WebSocket open — sending setup");
        const setupMsg = {
          setup: {
            model,
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: "Aoede" },
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
        ws.send(JSON.stringify(setupMsg));
      });

      ws.on("message", (raw: Buffer) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(raw.toString()); }
        catch { return; }

        if (msg.setupComplete) {
          logger.info({ apiVersion, model }, "Gemini Live setup complete ✅");
          this.isSetup = true;
          if (!settled) { settled = true; resolve(); }
          return;
        }

        if (msg.error) {
          logger.error({ geminiError: msg.error }, "Gemini error message");
        }

        // Forward model audio/text responses
        if (msg.serverContent) {
          this.handleContent(msg.serverContent as Record<string, unknown>);
        }
      });

      ws.on("error", (err) => {
        logger.error({ err, apiVersion, model }, "WebSocket error");
        fail(err as Error);
      });

      ws.on("close", (code: number, reason: Buffer) => {
        const reasonStr = reason.toString();
        logger.warn({ code, reason: reasonStr, apiVersion, model }, "WebSocket closed");

        if (!settled) {
          if (code === 1008) {
            // Model not supported on this API version — try next candidate
            logger.info({ nextIdx: idx + 1 }, "Trying next model/version candidate");
            this.tryConnect(apiKey, idx + 1).then(resolve, reject);
          } else {
            fail(new Error(`Gemini closed (code=${code} reason=${reasonStr})`));
          }
          return;
        }

        // Already set up — emit close for reconnect logic if needed
        this.emit("close");
      });
    });
  }

  private handleContent(content: Record<string, unknown>) {
    const modelTurn = content.modelTurn as Record<string, unknown> | undefined;
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
        turns: [{ role: "user", parts: [{ text }] }],
        turnComplete: true,
      },
    };
    this.ws.send(JSON.stringify(msg));
  }

  close() {
    try { this.ws?.close(); } catch (_) {}
    this.ws = null;
    this.isSetup = false;
  }
}
