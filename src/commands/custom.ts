import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
} from "discord.js";
import { botName } from "../core/server.ts";
import { automodCommand } from "../panels/automod.ts";
import { classicCommands } from "./classic.ts";
import { log } from "../core/log.ts";
import { readJson, withLock, writeJson } from "../core/memory.ts";
import { reflexesCommand } from "../chat/reflexes.ts";
import { memoryCommand } from "../panels/memory.ts";
import { statusCommand } from "../core/budget.ts";
import { cguCommand } from "../core/consent.ts";
import { announceCommand } from "../panels/announces.ts";
import { personalityCommand } from "../panels/personality.ts";

// Commande perso : son contenu est rédigé une fois par l'IA, puis servi par le bot sans IA.
export interface CustomCommand {
  name: string;
  description: string;
  response: string;
  ephemeral: boolean;
  adminOnly: boolean;
}

const FILE = "commandes.json";
const cache = new Map<string, CustomCommand[]>();

export const commandsPanelCommand = new SlashCommandBuilder()
  .setName("commandes")
  .setDescription("Voir et gérer les commandes perso")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setContexts(InteractionContextType.Guild);

const BUILT_IN = [...classicCommands, automodCommand, commandsPanelCommand, reflexesCommand, memoryCommand, statusCommand, cguCommand, announceCommand, personalityCommand];
export const RESERVED_NAMES = new Set(BUILT_IN.map((c) => c.name));

// Permission exigée par une commande intégrée, revérifiée à chaque utilisation : les admins du serveur peuvent
// rouvrir une commande à d'autres rôles (Paramètres du serveur → Intégrations), mais le bot ne fait jamais
// plus que ce que la personne aurait le droit de faire elle-même.
export function requiredPermission(commandName: string): bigint | null {
  const permissions = BUILT_IN.find((c) => c.name === commandName)?.default_member_permissions;
  return permissions ? BigInt(permissions) : null;
}

export async function getCustomCommands(guildId: string): Promise<CustomCommand[]> {
  let commands = cache.get(guildId);
  if (!commands) {
    commands = await readJson<CustomCommand[]>(guildId, FILE, []);
    cache.set(guildId, commands);
  }
  return commands;
}

// Enregistre auprès de Discord les commandes intégrées et les commandes perso du serveur.
export async function syncCommands(guild: Guild): Promise<void> {
  const custom = (await getCustomCommands(guild.id)).map((c) => {
    const builder = new SlashCommandBuilder().setName(c.name).setDescription(c.description).setContexts(InteractionContextType.Guild);
    if (c.adminOnly) builder.setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
    return builder;
  });
  await guild.commands.set([...BUILT_IN, ...custom]);
}

async function save(guild: Guild, commands: CustomCommand[]): Promise<void> {
  await writeJson(guild.id, FILE, commands);
  cache.set(guild.id, commands);
  await syncCommands(guild);
}

// Crée la commande, ou la remplace si elle existe déjà.
// Lecture et écriture sous verrou : deux commandes créées en même temps ne s'écrasent pas.
const lock = <T>(guild: Guild, fn: () => Promise<T>) => withLock(`${guild.id}/${FILE}`, fn);

export async function saveCustomCommand(guild: Guild, command: CustomCommand): Promise<"créée" | "mise à jour"> {
  if (RESERVED_NAMES.has(command.name)) throw new Error(`/${command.name} est une commande intégrée du bot`);
  return lock(guild, async () => {
    const commands = await getCustomCommands(guild.id);
    const exists = commands.some((c) => c.name === command.name);
    await save(guild, [...commands.filter((c) => c.name !== command.name), command]);
    return exists ? "mise à jour" : "créée";
  });
}

export async function deleteCustomCommand(guild: Guild, name: string): Promise<CustomCommand | null> {
  return lock(guild, async () => {
    const commands = await getCustomCommands(guild.id);
    const command = commands.find((c) => c.name === name) ?? null;
    if (command) await save(guild, commands.filter((c) => c.name !== name));
    return command;
  });
}

// Répond à une commande perso, sans IA. Renvoie false si ce n'est pas une commande perso.
export async function handleCustomCommand(interaction: ChatInputCommandInteraction<"cached">): Promise<boolean> {
  const command = (await getCustomCommands(interaction.guildId)).find((c) => c.name === interaction.commandName);
  if (!command) return false;
  if (command.adminOnly && !interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "Réservé aux admins.", flags: MessageFlags.Ephemeral });
    return true;
  }
  const content = command.response
    .replaceAll("{membre}", `${interaction.user}`)
    .replaceAll("{serveur}", interaction.guild.name)
    .replaceAll("{salon}", `${interaction.channel}`);
  await interaction.reply({
    content,
    allowedMentions: { parse: [] },
    ...(command.ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
  });
  return true;
}

// --- Panneau /commandes : voir et supprimer les commandes perso, sans IA ---

async function panel(guild: Guild) {
  const commands = await getCustomCommands(guild.id);
  const embed = new EmbedBuilder().setTitle("⌨️ Commandes perso").setColor(0xc9a227);
  if (!commands.length) embed.setDescription(`Aucune commande perso.\nCrées-en une avec « @${botName(guild)} crée une commande /regles qui affiche le règlement ».`);
  for (const c of commands.slice(0, 25)) {
    const flags = [c.ephemeral ? "réponse privée" : "réponse publique", c.adminOnly && "admins seulement"].filter(Boolean).join(", ");
    embed.addFields({ name: `/${c.name}`, value: `${c.description} (${flags})\n> ${c.response.slice(0, 300).replaceAll("\n", "\n> ")}`.slice(0, 1024) });
  }
  const buttons = commands
    .slice(0, 25)
    .map((c) => new ButtonBuilder().setCustomId(`cmds:ask:${c.name}`).setLabel(`🗑️ /${c.name}`).setStyle(ButtonStyle.Danger));
  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += 5) components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)));
  return { content: "", embeds: [embed], components };
}

export async function showCommandsPanel(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
  await interaction.reply({ ...(await panel(interaction.guild)), flags: MessageFlags.Ephemeral });
}

export async function handleCommandsPanel(interaction: ButtonInteraction<"cached">): Promise<void> {
  if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "Réservé aux admins.", flags: MessageFlags.Ephemeral });
    return;
  }
  const [, action, name] = interaction.customId.split(":");
  if (action === "ask" && name) {
    const confirm = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`cmds:delete:${name}`).setLabel(`Supprimer /${name}`).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("cmds:back").setLabel("Annuler").setStyle(ButtonStyle.Secondary),
    );
    await interaction.update({ content: `⚠️ Supprimer la commande **/${name}** ?`, components: [confirm] });
    return;
  }
  if (action === "delete" && name) {
    const command = await deleteCustomCommand(interaction.guild, name);
    if (command) await log(interaction.guild, "Commandes", `🗑️ ${interaction.user} a supprimé la commande perso /${command.name}`);
  }
  // "delete" et "back" reviennent au panneau à jour.
  await interaction.update(await panel(interaction.guild));
}
