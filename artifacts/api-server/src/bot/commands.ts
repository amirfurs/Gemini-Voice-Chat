import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  GuildMember,
} from "discord.js";
import {
  joinVoiceChannel,
  getVoiceConnection,
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
      ephemeral: true,
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
        ephemeral: true,
      });
      return;
    }

    if (!voiceChannel.isVoiceBased()) {
      await interaction.reply({
        content: "That's not a voice channel.",
        ephemeral: true,
      });
      return;
    }

    // Clean up existing session
    if (sessions.has(guildId)) {
      sessions.get(guildId)!.destroy();
      sessions.delete(guildId);
    }

    await interaction.deferReply();

    try {
      const apiKey = process.env["GEMINI_API_KEY"];
      if (!apiKey) throw new Error("GEMINI_API_KEY not set");

      const gemini = new GeminiLiveSession(apiKey);
      await gemini.connect();

      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });

      await entersState(connection, VoiceConnectionStatus.Ready, 10_000);

      const session = new VoiceSession(connection, gemini);
      sessions.set(guildId, session);

      logger.info({ guildId, channelId: voiceChannel.id }, "Bot joined voice channel");

      await interaction.editReply(
        `Joined **${voiceChannel.name}**! I'm listening — speak and I'll respond using Gemini Live. Use \`/leave\` to disconnect.`
      );
    } catch (err) {
      logger.error({ err }, "Failed to join voice channel");
      await interaction.editReply(
        "Failed to join or connect to Gemini Live. Check that your GEMINI_API_KEY is valid."
      );
    }
  } else if (interaction.commandName === "leave") {
    const session = sessions.get(guildId);
    if (session) {
      session.destroy();
      sessions.delete(guildId);
      await interaction.reply("Left the voice channel. Goodbye!");
    } else {
      await interaction.reply({
        content: "I'm not in a voice channel right now.",
        ephemeral: true,
      });
    }
  }
}
