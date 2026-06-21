import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  GuildMember,
} from "discord.js";
import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
} from "@discordjs/voice";
import { GeminiSession } from "./gemini-session";
import { VoiceSession } from "./voice-session";
import { logger } from "../lib/logger";

const sessions = new Map<string, VoiceSession>();

export const commands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Join your voice channel and chat with Gemini AI"),
  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Leave the voice channel"),
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask Gemini a question via text (bot responds with voice)")
    .addStringOption((opt) =>
      opt.setName("question").setDescription("Your question").setRequired(true)
    ),
];

export async function handleInteraction(
  interaction: ChatInputCommandInteraction
) {
  if (!interaction.guildId) {
    await interaction.reply({
      content: "This command only works in a server.",
      flags: 64,
    });
    return;
  }

  const guildId = interaction.guildId;

  if (interaction.commandName === "join") {
    const member = interaction.member as GuildMember;
    const voiceChannel = member?.voice?.channel;

    if (!voiceChannel) {
      await interaction.reply({
        content: "You need to be in a voice channel first!",
        flags: 64,
      });
      return;
    }

    if (!voiceChannel.isVoiceBased()) {
      await interaction.reply({
        content: "That's not a voice channel.",
        flags: 64,
      });
      return;
    }

    if (sessions.has(guildId)) {
      sessions.get(guildId)!.destroy();
      sessions.delete(guildId);
    }

    await interaction.deferReply();

    const apiKey = process.env["GEMINI_API_KEY"];
    if (!apiKey) {
      await interaction.editReply("❌ GEMINI_API_KEY is not configured.");
      return;
    }

    let connection;
    try {
      connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
      logger.info({ guildId, channelId: voiceChannel.id }, "Joined voice channel");
    } catch (err) {
      logger.error({ err }, "Failed to join voice channel");
      connection?.destroy();
      await interaction.editReply(
        "❌ Failed to join the voice channel. Make sure I have **Connect** and **Speak** permissions."
      );
      return;
    }

    let gemini: GeminiSession | null = null;
    try {
      gemini = new GeminiSession();
      await gemini.connect(apiKey);
      logger.info("Gemini API ready");
    } catch (err) {
      logger.error({ err }, "Failed to connect to Gemini");
      connection.destroy();
      await interaction.editReply(
        `❌ Joined voice but Gemini API failed.\n\nError: \`${(err as Error).message}\`\n\nCheck that your **GEMINI_API_KEY** is valid.`
      );
      return;
    }

    const session = new VoiceSession(connection, gemini);
    sessions.set(guildId, session);

    await interaction.editReply(
      `✅ Joined **${voiceChannel.name}**! المحاور السلفي is active — speak Arabic and he'll respond with voice. Use \`/ask\` to send a text question, or \`/leave\` to disconnect.`
    );

    // Trigger self-introduction after joining
    session.introduce().catch((err) =>
      logger.error({ err }, "Failed to send introduction")
    );

  } else if (interaction.commandName === "leave") {
    const session = sessions.get(guildId);
    if (session) {
      session.destroy();
      sessions.delete(guildId);
      await interaction.reply("👋 Left the voice channel. Goodbye!");
    } else {
      await interaction.reply({
        content: "I'm not in a voice channel right now.",
        flags: 64,
      });
    }

  } else if (interaction.commandName === "ask") {
    const session = sessions.get(guildId);
    if (!session) {
      await interaction.reply({
        content: "I need to be in a voice channel first. Use `/join`.",
        flags: 64,
      });
      return;
    }

    const question = interaction.options.getString("question", true);
    await interaction.deferReply();

    try {
      await session.askText(question);
      await interaction.editReply(`🎙️ Speaking: *"${question}"*`);
    } catch (err) {
      logger.error({ err }, "Error in /ask command");
      await interaction.editReply("❌ Something went wrong. Check the logs.");
    }
  }
}
