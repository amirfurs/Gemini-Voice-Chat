import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import WebSocket from "ws";
import { logger } from "../lib/logger";

const MODEL = "models/gemini-3.1-flash-live-preview";
const API_VERSIONS = ["v1beta", "v1alpha"];

const SYSTEM_PROMPT = `
# الهوية والدور الأساسي (Role & Identity)
أنت الآن "المحاور السلفي"، ذكاء اصطناعي متقدم وباحث شرعي متخصص في الرد على الشبهات الموجهة ضد الدين الإسلامي.
عقيدتك ومنهجك هو "منهج السلف الصالح" (أهل السنة والجماعة)، وتتبنى تحديداً الطريقة العلمية والجدلية لشيخ الإسلام ابن تيمية، والإمام ابن القيم، وأئمة الدعوة.
مستواك متقدم جداً؛ تجمع ببراعة فائقة بين "الأدلة النقلية" (القرآن، السنة الصحيحة، وإجماع السلف) و"الأدلة العقلية" (المنطق السليم، الفطرة، والمقاييس العقلية الصحيحة).

# المنهجية في الحوار والرد (Dialectical Methodology)
1. الجمع بين العقل والنقل: تؤمن يقيناً بأنه "لا تعارض بين صريح المعقول وصحيح المنقول"، وتستخدم هذه القاعدة لرد الشبهات العقلية والفلسفية.
2. هدم أصول الشبهة: لا تكتفِ بالرد على فروع الشبهة، بل ابحث عن "المقدمات الفاسدة" التي بنى عليها الخصم شبهته واهدمها من الأساس.
3. بيان تناقض الخصم (الإلزام والنقض): استخدم أسلوب الإلزام (إلزام الخصم بلوازم قوله الفاسدة) والنقض (بيان تناقض معاييره)، مع إظهار تهافت منطقه.
4. الاعتماد على التراث: يجب أن تكون ردودك مدعمة بالنقولات الدقيقة من كتب التراث (مثل: درء تعارض العقل والنقل، الجواب الصحيح لمن بدل دين المسيح، منهاج السنة النبوية، وغيرها).
5. اللغة والأسلوب: لغتك فصحى، رصينة، قوية، واثقة، وأكاديمية. لا تستخدم أسلوباً هجومياً بذيئاً، بل حزماً علمياً يفحم الخصم بالحجة والبرهان، مع إظهار العزة بدين الإسلام.

# خطوات تنفيذ الرد عند طرح شبهة
1. تحليل الشبهة: فكك دعوى الخصم إلى مقدمات ونتيجة.
2. تحرير محل النزاع: وضح المسألة بدقة.
3. اعرض الرد النقلي: الآيات، الأحاديث، أو كلام العلماء مع العزو.
4. اعرض الرد العقلي: بيّن الفساد المنطقي في طعن الخصم.
5. اختم بالإلزام: اقلب حجة الخصم عليه.

# تعليمات خاصة بالصوت
- عند الانضمام إلى القناة الصوتية، قدّم نفسك باختصار بالعربية الفصحى.
- تحدث بصوت واثق وعلمي يليق بمقام الباحث الشرعي.
- اجعل إجاباتك الصوتية موجزة ومركزة (جملتان إلى أربع جمل) ثم اسأل إن كان المستمع يريد التفصيل.
- إذا طُرحت شبهة، لا تتعجل بل ابدأ بقول: "الجواب عن هذه الشبهة من وجوه..." ثم اذكر الوجه الأول فقط، وانتظر ردة فعل المستمع.
`.trim();

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

function resamplePcm(pcm: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const ff = spawn("ffmpeg", [
      "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "pipe:0",
      "-f", "s16le", "-ar", "16000", "-ac", "1", "pipe:1",
    ]);
    ff.stdout.on("data", (c: Buffer) => chunks.push(c));
    ff.stdout.on("end", () => resolve(Buffer.concat(chunks)));
    ff.stderr.on("data", () => {});
    ff.on("error", reject);
    ff.stdin.write(pcm);
    ff.stdin.end();
  });
}

export class GeminiSession extends EventEmitter {
  private ws: WebSocket | null = null;
  private receivedPcm: Buffer[] = [];
  private outputSampleRate = 24000;
  private outputChannels = 1;
  private processing = false;

  async connect(apiKey: string): Promise<void> {
    for (const apiVersion of API_VERSIONS) {
      try {
        await this.tryConnect(apiKey, apiVersion);
        logger.info({ apiVersion, model: MODEL }, "Gemini Live connected ✅");
        return;
      } catch (err) {
        logger.warn({ apiVersion, err: (err as Error).message }, "Version failed, trying next");
      }
    }
    throw new Error(
      `Could not connect to Gemini Live with model ${MODEL}. ` +
      `Make sure your API key has access to this model in AI Studio.`
    );
  }

  private tryConnect(apiKey: string, apiVersion: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url =
        `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.` +
        `${apiVersion}.GenerativeService.BidiGenerateContent?key=${apiKey}`;

      const ws = new WebSocket(url);
      let resolved = false;

      const fail = (err: Error) => {
        if (!resolved) { resolved = true; reject(err); }
      };

      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            setup: {
              model: MODEL,
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: "Aoede" },
                  },
                },
              },
              systemInstruction: {
                parts: [{ text: SYSTEM_PROMPT }],
              },
            },
          })
        );
      });

      ws.on("message", (raw) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        } catch {
          return;
        }

        if (msg.setupComplete) {
          if (!resolved) { resolved = true; this.ws = ws; resolve(); }
          return;
        }

        const serverContent = msg.serverContent as Record<string, unknown> | undefined;
        if (!serverContent) return;

        const modelTurn = serverContent.modelTurn as Record<string, unknown> | undefined;
        if (modelTurn) {
          const parts = modelTurn.parts as Array<Record<string, unknown>> | undefined;
          if (parts) {
            for (const part of parts) {
              const inlineData = part.inlineData as Record<string, unknown> | undefined;
              if (inlineData) {
                const mimeType = inlineData.mimeType as string | undefined;
                const data = inlineData.data as string | undefined;
                if (mimeType?.startsWith("audio/") && data) {
                  this.receivedPcm.push(Buffer.from(data, "base64"));
                  // Parse sample rate if provided
                  const rateMatch = mimeType.match(/rate=(\d+)/);
                  if (rateMatch) this.outputSampleRate = parseInt(rateMatch[1]!, 10);
                }
              }
            }
          }
        }

        if (serverContent.turnComplete) {
          const pcm = Buffer.concat(this.receivedPcm);
          this.receivedPcm = [];
          if (pcm.length > 0) {
            logger.info({ bytes: pcm.length, sampleRate: this.outputSampleRate }, "Gemini audio turn complete");
            const wav = pcmToWav(pcm, this.outputSampleRate, this.outputChannels);
            const stream = new Readable({ read() {} });
            stream.push(wav);
            stream.push(null);
            this.emit("audioStream", stream);
          }
        }
      });

      ws.on("close", (code, reason) => {
        if (!resolved) {
          fail(new Error(`WebSocket closed: ${code} ${reason.toString()}`));
        }
      });

      ws.on("error", (err) => fail(err as Error));
    });
  }

  async processPcm(pcm48kStereo: Buffer): Promise<void> {
    if (!this.ws || this.processing) return;
    if (pcm48kStereo.length < 960 * 2 * 2) return; // too short

    this.processing = true;
    try {
      const pcm16k = await resamplePcm(pcm48kStereo);
      logger.info({ bytes: pcm16k.length }, "Sending audio to Gemini Live");

      this.ws.send(
        JSON.stringify({
          realtimeInput: {
            mediaChunks: [{
              mimeType: "audio/pcm;rate=16000",
              data: pcm16k.toString("base64"),
            }],
          },
        })
      );
    } catch (err) {
      logger.error({ err }, "Failed to send audio");
    } finally {
      this.processing = false;
    }
  }

  async introduce(): Promise<void> {
    await this.sendText(
      "قدّم نفسك الآن باختصار وبصوت عالٍ واضح، واذكر اسمك ودورك وكيف يمكن للمستمعين الاستفادة منك."
    );
  }

  async sendText(text: string): Promise<void> {
    if (!this.ws) return;
    this.ws.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: "user", parts: [{ text }] }],
          turnComplete: true,
        },
      })
    );
  }

  close() {
    this.ws?.close(1000);
    this.ws = null;
    this.receivedPcm = [];
    this.processing = false;
  }
}
