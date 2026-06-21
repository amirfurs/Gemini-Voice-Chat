import {
  Client,
  GatewayIntentBits,
  Events,
  ChatInputCommandInteraction,
} from "discord.js";
import { handleInteraction } from "./commands";
import { registerCommands } from "./register-commands";
import { logger } from "../lib/logger";

export async function startBot() {
  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) {
    logger.error("DISCORD_BOT_TOKEN is not set — Discord bot will not start");
    return;
  }

  // Register slash commands on startup
  try {
    await registerCommands();
  } catch (err) {
    logger.error({ err }, "Failed to register slash commands");
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
    ],
  });

  client.once(Events.ClientReady, (readyClient) => {
    logger.info({ tag: readyClient.user.tag }, "Discord bot is ready");
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      await handleInteraction(interaction as ChatInputCommandInteraction);
    } catch (err) {
      logger.error({ err }, "Error handling interaction");
    }
  });

  await client.login(token);
}
