import { ActivityType, Client, Events, GatewayIntentBits, MessageFlags, type Guild } from "discord.js";
import { describeProviders } from "./ai/index.ts";
import { registerAuditLogs } from "./moderation/audit.ts";
import { moderate, prepareSignals } from "./moderation/automod.ts";
import { handleAutomodPanel, showAutomodPanel } from "./panels/automod.ts";
import { handleClassicCommand } from "./commands/classic.ts";
import { handleCommandsPanel, handleCustomCommand, requiredPermission, showCommandsPanel, syncCommands } from "./commands/custom.ts";
import { log, logConsole } from "./core/log.ts";
import { say } from "./core/personality.ts";
import { handleMention } from "./brain/mention.ts";
import { handleConsentComponent, showTerms } from "./core/consent.ts";
import { handleAnnouncePanel, showAnnouncePanel } from "./panels/announces.ts";
import { handlePersonalityPanel, showPersonalityPanel } from "./panels/personality.ts";
import { handleEvolutionComponent, startEvolution } from "./brain/evolution.ts";
import { handleMemoryComponent, showMemoryPanel } from "./panels/memory.ts";
import { handleBudgetComponent, showStatusPanel } from "./core/budget.ts";
import { handleReflexesComponent, showReflexesPanel } from "./chat/reflexes.ts";
import { getRules } from "./moderation/rules.ts";
import { isAllowedGuild, SERVER_ID } from "./core/server.ts";
import { handleTeachComponent } from "./chat/teach.ts";

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("DISCORD_TOKEN manquant : copie .env.example en .env et remplis-le.");
if (!SERVER_ID) throw new Error("SERVER_ID manquant dans .env : l'identifiant de ton serveur (clic droit sur le serveur → Copier l'identifiant).");

async function leaveIfForeign(guild: Guild): Promise<boolean> {
  if (isAllowedGuild(guild.id)) return false;
  logConsole("Sécurité", `ajouté sur un serveur non autorisé, « ${guild.name} » (${guild.id}) : départ immédiat`);
  await guild.leave().catch((error) => logConsole("Erreur", `départ de ${guild.id} impossible : ${error}`));
  return true;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
  ],
});

// Statut du bot, qui tourne toutes les 2 minutes (sans IA). Un bot n'a pas droit à la « Rich Presence »
// complète des jeux (images, boutons) : seulement un texte de statut.
const PRESENCE_INTERVAL_MS = 2 * 60_000;
let presenceIndex = 0;

async function updatePresence(): Promise<void> {
  const home = client.guilds.cache.find((guild) => isAllowedGuild(guild.id));
  if (!home || !client.user) return;
  const rules = (await getRules(home.id)).length;
  const keys = ["presenceMembers", "presenceChat", "presenceAutomod", "presenceServer"] as const;
  const state = await say(home.id, keys[presenceIndex++ % keys.length]!, { membres: home.memberCount, regles: rules, serveur: home.name });
  client.user.setPresence({ status: "online", activities: [{ type: ActivityType.Custom, name: "Statut", state }] });
}

client.once(Events.ClientReady, async (ready) => {
  // Enregistrées par serveur (mise à jour immédiate) plutôt qu'en global (propagation lente côté Discord).
  await ready.application.commands.set([]);
  for (const guild of ready.guilds.cache.values()) {
    if (!(await leaveIfForeign(guild))) await syncCommands(guild);
  }
  const home = ready.guilds.cache.find((guild) => isAllowedGuild(guild.id));
  // Charge la liste des membres une fois, pour reconnaître un pseudo cité sans mention (« tu penses quoi de Yusisako ? »).
  await home?.members.fetch().catch((error) => logConsole("Erreur", `chargement des membres : ${error}`));
  // Les règles d'automod sans pré-filtre le reçoivent une fois (un appel par règle, jamais refait).
  if (home) prepareSignals(home).catch((error) => logConsole("Erreur", `pré-filtre : ${error}`));
  // Le bilan : tout de suite sur un serveur qui n'en a jamais eu (fiche et personnalité), puis chaque semaine.
  if (home) startEvolution(home);
  logConsole("Démarrage", `⚓ ${ready.user.tag} a pris la mer sur ${home ? `« ${home.name} »` : "aucun serveur (SERVER_ID ne correspond à aucun serveur du bot)"} · IA : ${describeProviders()}`);
  await updatePresence();
  setInterval(() => updatePresence().catch((error) => logConsole("Erreur", `statut : ${error}`)), PRESENCE_INTERVAL_MS);
});

client.on(Events.GuildCreate, async (guild) => {
  if (await leaveIfForeign(guild)) return;
  syncCommands(guild).catch((error) => logConsole("Erreur", `enregistrement des commandes : ${error}`));
});

// Commandes classiques, commandes perso et panneaux (/automod, /commandes) : tout ça tourne sans IA.
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.inCachedGuild() || !isAllowedGuild(interaction.guildId)) return;
  if ((interaction.isButton() || interaction.isStringSelectMenu()) && interaction.customId.startsWith("automod:")) {
    await handleAutomodPanel(interaction).catch((error) => logConsole("Erreur", `panneau automod : ${error}`));
    return;
  }
  if (
    (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isChannelSelectMenu() || interaction.isModalSubmit()) &&
    interaction.customId.startsWith("annonce:")
  ) {
    await handleAnnouncePanel(interaction).catch((error) => logConsole("Erreur", `panneau annonces : ${error}`));
    return;
  }
  if ((interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) && interaction.customId.startsWith("perso:")) {
    await handlePersonalityPanel(interaction).catch((error) => logConsole("Erreur", `panneau personnalité : ${error}`));
    return;
  }
  if (interaction.isButton() && interaction.customId.startsWith("bilan:")) {
    await handleEvolutionComponent(interaction).catch((error) => logConsole("Erreur", `annulation du bilan : ${error}`));
    return;
  }
  if (interaction.isButton() && interaction.customId.startsWith("consent:")) {
    await handleConsentComponent(interaction, handleMention).catch((error) => logConsole("Erreur", `accord : ${error}`));
    return;
  }
  if (interaction.isButton() && interaction.customId.startsWith("budget:")) {
    await handleBudgetComponent(interaction).catch((error) => logConsole("Erreur", `panneau budget : ${error}`));
    return;
  }
  if ((interaction.isButton() || interaction.isStringSelectMenu()) && interaction.customId.startsWith("mem:")) {
    await handleMemoryComponent(interaction).catch((error) => logConsole("Erreur", `panneau mémoire : ${error}`));
    return;
  }
  if (interaction.isButton() && interaction.customId.startsWith("teach:")) {
    await handleTeachComponent(interaction).catch((error) => logConsole("Erreur", `validation mémoire : ${error}`));
    return;
  }
  if ((interaction.isButton() || interaction.isStringSelectMenu()) && interaction.customId.startsWith("reflex:")) {
    await handleReflexesComponent(interaction).catch((error) => logConsole("Erreur", `panneau réflexes : ${error}`));
    return;
  }
  if (interaction.isButton() && interaction.customId.startsWith("cmds:")) {
    await handleCommandsPanel(interaction).catch((error) => logConsole("Erreur", `panneau commandes : ${error}`));
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  await log(interaction.guild, "Commande", `⌨️ ${interaction.user} : \`${interaction.toString()}\` dans ${interaction.channel}`);
  const required = requiredPermission(interaction.commandName);
  if (required !== null && !interaction.memberPermissions.has(required)) {
    await interaction.reply({ content: "⛔ Il te manque la permission Discord nécessaire pour cette commande.", flags: MessageFlags.Ephemeral });
    return;
  }
  try {
    if (interaction.commandName === "automod") await showAutomodPanel(interaction);
    else if (interaction.commandName === "commandes") await showCommandsPanel(interaction);
    else if (interaction.commandName === "reflexes") await showReflexesPanel(interaction);
    else if (interaction.commandName === "memoire") await showMemoryPanel(interaction);
    else if (interaction.commandName === "status") await showStatusPanel(interaction);
    else if (interaction.commandName === "cgu") await showTerms(interaction);
    else if (interaction.commandName === "annonces") await showAnnouncePanel(interaction);
    else if (interaction.commandName === "personnalite") await showPersonalityPanel(interaction);
    else if (!(await handleCustomCommand(interaction))) await handleClassicCommand(interaction);
  } catch (error) {
    console.error(error);
    await log(interaction.guild, "Erreur", `💥 Erreur sur \`${interaction.toString()}\` : ${error instanceof Error ? error.message : error}`);
    const content = "💥 La commande a échoué. Réessaie dans un instant.";
    if (interaction.deferred || interaction.replied) await interaction.editReply(content).catch(() => {});
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

// Chaque message passe par l'automod ; une mention du bot déclenche une réponse.
client.on(Events.MessageCreate, (message) => {
  if (!isAllowedGuild(message.guildId)) return;
  moderate(message).catch((error) => logConsole("Erreur", `automod : ${error}`));
  handleMention(message).catch(async (error) => {
    logConsole("Erreur", `mention : ${error}`);
    if (message.inGuild()) await message.reply(await say(message.guildId, "crash")).catch(() => {});
  });
});

registerAuditLogs(client);
await client.login(token);
