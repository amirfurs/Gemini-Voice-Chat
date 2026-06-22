import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  GuildMember,
  TextChannel,
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
    .setDescription("Join your voice channel — only you can talk to the bot by default"),

  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Leave the voice channel"),

  new SlashCommandBuilder()
    .setName("permit")
    .setDescription("Grant another user permission to talk to the bot (owner only)")
    .addUserOption((opt) =>
      opt.setName("user").setDescription("The user to permit").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("revoke")
    .setDescription("Remove a user's permission to talk to the bot (owner only)")
    .addUserOption((opt) =>
      opt.setName("user").setDescription("The user to revoke").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("permissions")
    .setDescription("List who is currently permitted to talk to the bot"),

  new SlashCommandBuilder()
    .setName("read")
    .setDescription("Have the bot read and comment on recent chat messages (owner only)")
    .addIntegerOption((opt) =>
      opt
        .setName("count")
        .setDescription("Number of recent messages to read (default: 10, max: 50)")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Send the bot a text question — it responds with voice (owner only)")
    .addStringOption((opt) =>
      opt.setName("question").setDescription("Your question").setRequired(true)
    ),
];

function isOwner(interaction: ChatInputCommandInteraction, session: VoiceSession): boolean {
  return interaction.user.id === session.owner;
}

export async function handleInteraction(
  interaction: ChatInputCommandInteraction
) {
  if (!interaction.guildId) {
    await interaction.reply({ content: "This command only works in a server.", flags: 64 });
    return;
  }

  const guildId = interaction.guildId;
  const cmd = interaction.commandName;

  // ── /join ────────────────────────────────────────────────────────────
  if (cmd === "join") {
    const member = interaction.member as GuildMember;
    const voiceChannel = member?.voice?.channel;

    if (!voiceChannel) {
      await interaction.reply({ content: "You need to be in a voice channel first!", flags: 64 });
      return;
    }
    if (!voiceChannel.isVoiceBased()) {
      await interaction.reply({ content: "That's not a voice channel.", flags: 64 });
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
      await interaction.editReply("❌ Failed to join. Make sure I have **Connect** and **Speak** permissions.");
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
        `❌ Joined voice but Gemini failed.\n\nError: \`${(err as Error).message}\``
      );
      return;
    }

    const ownerId = interaction.user.id;
    const session = new VoiceSession(connection, gemini, ownerId);
    sessions.set(guildId, session);

    await interaction.editReply(
      `✅ Joined **${voiceChannel.name}**!\n` +
      `🔒 Only **you** can talk to المحاور السلفي by default.\n` +
      `Use \`/permit @user\` to allow others • \`/read\` to share chat • \`/leave\` to disconnect.`
    );

    session.introduce().catch((err) => logger.error({ err }, "Failed to send introduction"));

  // ── /leave ───────────────────────────────────────────────────────────
  } else if (cmd === "leave") {
    const session = sessions.get(guildId);
    if (session) {
      session.destroy();
      sessions.delete(guildId);
      await interaction.reply("👋 Left the voice channel. Goodbye!");
    } else {
      await interaction.reply({ content: "I'm not in a voice channel right now.", flags: 64 });
    }

  // ── /permit ──────────────────────────────────────────────────────────
  } else if (cmd === "permit") {
    const session = sessions.get(guildId);
    if (!session) {
      await interaction.reply({ content: "I'm not active. Use `/join` first.", flags: 64 });
      return;
    }
    if (!isOwner(interaction, session)) {
      await interaction.reply({ content: "❌ Only the owner who ran `/join` can grant permissions.", flags: 64 });
      return;
    }
    const target = interaction.options.getUser("user", true);
    session.permitUser(target.id);
    await interaction.reply(`✅ **${target.displayName}** can now talk to المحاور السلفي.`);

  // ── /revoke ──────────────────────────────────────────────────────────
  } else if (cmd === "revoke") {
    const session = sessions.get(guildId);
    if (!session) {
      await interaction.reply({ content: "I'm not active. Use `/join` first.", flags: 64 });
      return;
    }
    if (!isOwner(interaction, session)) {
      await interaction.reply({ content: "❌ Only the owner can revoke permissions.", flags: 64 });
      return;
    }
    const target = interaction.options.getUser("user", true);
    if (target.id === session.owner) {
      await interaction.reply({ content: "❌ You can't revoke your own owner permissions.", flags: 64 });
      return;
    }
    session.revokeUser(target.id);
    await interaction.reply(`🚫 **${target.displayName}**'s permission has been revoked.`);

  // ── /permissions ─────────────────────────────────────────────────────
  } else if (cmd === "permissions") {
    const session = sessions.get(guildId);
    if (!session) {
      await interaction.reply({ content: "I'm not active. Use `/join` first.", flags: 64 });
      return;
    }
    const list = session.getPermittedList();
    const lines = list.map((id, i) =>
      i === 0 ? `👑 <@${id}> (owner)` : `✅ <@${id}>`
    );
    await interaction.reply({
      content: `**Permitted users (${list.length}):**\n${lines.join("\n")}`,
      flags: 64,
    });

  // ── /read ────────────────────────────────────────────────────────────
  } else if (cmd === "read") {
    const session = sessions.get(guildId);
    if (!session) {
      await interaction.reply({ content: "I'm not active. Use `/join` first.", flags: 64 });
      return;
    }
    if (!isOwner(interaction, session)) {
      await interaction.reply({ content: "❌ Only the owner can ask the bot to read chat.", flags: 64 });
      return;
    }

    const count = Math.min(interaction.options.getInteger("count") ?? 10, 50);
    const channel = interaction.channel;

    if (!channel || !(channel instanceof TextChannel)) {
      await interaction.reply({ content: "❌ This command must be used in a text channel.", flags: 64 });
      return;
    }

    await interaction.deferReply({ flags: 64 });

    try {
      const fetched = await channel.messages.fetch({ limit: count });
      const messages = [...fetched.values()]
        .reverse()
        .filter((m) => !m.author.bot && m.content.trim().length > 0)
        .map((m) => ({ author: m.author.displayName, content: m.content }));

      if (messages.length === 0) {
        await interaction.editReply("No readable messages found.");
        return;
      }

      await session.readMessages(messages);
      await interaction.editReply(
        `📖 Sent **${messages.length}** messages to المحاور السلفي — he will comment via voice.`
      );
    } catch (err) {
      logger.error({ err }, "Failed to fetch messages");
      await interaction.editReply("❌ Failed to fetch messages.");
    }

  // ── /ask ─────────────────────────────────────────────────────────────
  } else if (cmd === "ask") {
    const session = sessions.get(guildId);
    if (!session) {
      await interaction.reply({ content: "I'm not in a voice channel. Use `/join` first.", flags: 64 });
      return;
    }
    if (!isOwner(interaction, session)) {
      await interaction.reply({ content: "❌ Only the owner can use `/ask`.", flags: 64 });
      return;
    }

    const question = interaction.options.getString("question", true);
    await interaction.deferReply();

    try {
      await session.askText(question);
      await interaction.editReply(`🎙️ Sent to المحاور السلفي: *"${question}"*`);
    } catch (err) {
      logger.error({ err }, "Error in /ask");
      await interaction.editReply("❌ Something went wrong.");
    }
  }
}
