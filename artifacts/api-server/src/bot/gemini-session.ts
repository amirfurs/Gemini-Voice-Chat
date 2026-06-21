import { GoogleGenAI } from "@google/genai";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { logger } from "../lib/logger";

function pcmToWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function splitText(text: string, maxLen: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]?/g) ?? [text];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    if ((current + " " + trimmed).trim().length <= maxLen) {
      current = (current + " " + trimmed).trim();
    } else {
      if (current) chunks.push(current);
      if (trimmed.length > maxLen) {
        // Split by words
        const words = trimmed.split(" ");
        let buf = "";
        for (const word of words) {
          if ((buf + " " + word).trim().length <= maxLen) {
            buf = (buf + " " + word).trim();
          } else {
            if (buf) chunks.push(buf);
            buf = word;
          }
        }
        if (buf) current = buf;
        else current = "";
      } else {
        current = trimmed;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks.filter((c) => c.length > 0);
}

async function textToSpeechStream(text: string): Promise<Readable> {
  const chunks = splitText(text, 190);
  const buffers: Buffer[] = [];

  for (const chunk of chunks) {
    const url =
      `https://translate.googleapis.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(chunk)}&tl=en&client=gtx&ttsspeed=0.9`;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (res.ok) {
        buffers.push(Buffer.from(await res.arrayBuffer()));
      }
    } catch (err) {
      logger.error({ err, chunk }, "TTS fetch failed for chunk");
    }
  }

  const combined = Buffer.concat(buffers);
  const readable = new Readable({ read() {} });
  readable.push(combined);
  readable.push(null);
  return readable;
}

export class GeminiSession extends EventEmitter {
  private ai: GoogleGenAI | null = null;
  private history: Array<{ role: string; parts: Array<{ text: string }> }> = [];
  private processing = false;
  private systemPrompt =
    "You are a helpful, friendly voice assistant in a Discord voice channel. " +
    "Keep responses short and conversational — 1 to 3 sentences maximum. Speak naturally.";

  async connect(apiKey: string): Promise<void> {
    this.ai = new GoogleGenAI({ apiKey });
    // Verify the key works
    await this.ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: "Reply with just the word: OK" }] }],
    });
    logger.info("Gemini API key verified ✅");
  }

  async processPcm(pcm: Buffer, sampleRate: number, channels: number): Promise<void> {
    if (!this.ai) return;
    if (this.processing) {
      logger.info("Already processing, skipping");
      return;
    }
    if (pcm.length < 960) {
      logger.info({ bytes: pcm.length }, "Audio too short, skipping");
      return;
    }

    this.processing = true;
    try {
      const wav = pcmToWav(pcm, sampleRate, channels);
      logger.info({ wavBytes: wav.length }, "Sending audio to Gemini");

      const response = await this.ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
          ...this.history,
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  mimeType: "audio/wav",
                  data: wav.toString("base64"),
                },
              } as never,
            ],
          },
        ],
        config: { systemInstruction: this.systemPrompt } as never,
      });

      const text = response.text?.trim();
      if (!text) {
        logger.warn("Gemini returned empty response");
        return;
      }

      logger.info({ text }, "Gemini text response");
      this.emit("text", text);

      this.history.push({ role: "user", parts: [{ text: "[voice message]" }] });
      this.history.push({ role: "model", parts: [{ text }] });
      if (this.history.length > 20) this.history = this.history.slice(-20);

      const audioStream = await textToSpeechStream(text);
      this.emit("audioStream", audioStream);
    } catch (err) {
      logger.error({ err }, "Error processing audio with Gemini");
    } finally {
      this.processing = false;
    }
  }

  async sendText(text: string): Promise<void> {
    if (!this.ai) return;
    try {
      const response = await this.ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
          ...this.history,
          { role: "user", parts: [{ text }] },
        ],
        config: { systemInstruction: this.systemPrompt } as never,
      });

      const responseText = response.text?.trim();
      if (!responseText) return;

      logger.info({ responseText }, "Gemini text response (from /ask)");
      this.emit("text", responseText);

      this.history.push({ role: "user", parts: [{ text }] });
      this.history.push({ role: "model", parts: [{ text: responseText }] });
      if (this.history.length > 20) this.history = this.history.slice(-20);

      const audioStream = await textToSpeechStream(responseText);
      this.emit("audioStream", audioStream);
    } catch (err) {
      logger.error({ err }, "Error sending text to Gemini");
    }
  }

  close() {
    this.ai = null;
    this.history = [];
    this.processing = false;
  }
}
