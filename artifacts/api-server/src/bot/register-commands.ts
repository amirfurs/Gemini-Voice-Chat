import { REST, Routes } from "discord.js";
import { commands } from "./commands";
import { logger } from "../lib/logger";

export async function registerCommands() {
  const token = process.env["DISCORD_BOT_TOKEN"];
  const clientId = process.env["DISCORD_CLIENT_ID"];

  if (!token || !clientId) {
    throw new Error("DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID must be set");
  }

  const rest = new REST({ version: "10" }).setToken(token);

  const commandData = commands.map((cmd) => cmd.toJSON());

  logger.info("Registering Discord slash commands...");
  await rest.put(Routes.applicationCommands(clientId), { body: commandData });
  logger.info("Slash commands registered successfully");
}
