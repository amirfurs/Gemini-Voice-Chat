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
import { GeminiLiveSession } from "./gemini-live";
import { VoiceSession } from "./voice-session";
import { logger } from "../lib/logger";

const sessions = new Map<string, VoiceSession>();

export const commands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Join your voice channel and start listening"),
  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Leave the voice channel"),
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

    // Clean up existing session
    if (sessions.has(guildId)) {
      sessions.get(guildId)!.destroy();
      sessions.delete(guildId);
    }

    await interaction.deferReply();

    const apiKey = process.env["GEMINI_API_KEY"];
    if (!apiKey) {
      await interaction.editReply("GEMINI_API_KEY is not configured.");
      return;
    }

    // Step 1: Join the voice channel first (independent of Gemini)
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
      logger.info({ guildId, channelId: voiceChannel.id }, "Bot joined voice channel");
    } catch (err) {
      logger.error({ err }, "Failed to join voice channel");
      connection?.destroy();
      await interaction.editReply(
        "❌ Failed to join the voice channel. Make sure I have **Connect** and **Speak** permissions."
      );
      return;
    }

    // Step 2: Connect to Gemini Live
    let gemini: GeminiLiveSession | null = null;
    try {
      gemini = new GeminiLiveSession(apiKey);
      await gemini.connect();
      logger.info("Gemini Live connected successfully");
    } catch (err) {
      logger.error({ err }, "Failed to connect to Gemini Live");
      connection.destroy();
      await interaction.editReply(
        `❌ Joined voice but failed to connect to Gemini Live.\n\nError: \`${(err as Error).message}\`\n\nMake sure your **GEMINI_API_KEY** has access to the Gemini Live API (gemini-2.0-flash-live-001). You can verify at aistudio.google.com.`
      );
      return;
    }

    // Step 3: Start the session
    const session = new VoiceSession(connection, gemini);
    sessions.set(guildId, session);

    await interaction.editReply(
      `✅ Joined **${voiceChannel.name}**! Gemini Live is active — speak and I'll respond with voice. Use \`/leave\` to disconnect.`
    );
  } else if (interaction.commandName === "leave") {
    const session = sessions.get(guildId);
    if (session) {
      session.destroy();
      sessions.delete(guildId);
      await interaction.reply("Left the voice channel. Goodbye!");
    } else {
      await interaction.reply({
        content: "I'm not in a voice channel right now.",
        flags: 64,
      });
    }
  }
}
