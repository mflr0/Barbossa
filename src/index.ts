import {
  Client,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { handleOrder } from "./admin.ts";
import { registerAuditLogs } from "./audit.ts";
import { moderate } from "./automod.ts";
import { classicCommands, handleClassicCommand } from "./commands.ts";
import { discover } from "./discovery.ts";
import { handleThreadMessage, startDiscussion } from "./discussion.ts";
import { log, logConsole } from "./log.ts";
import { handleAutomodCommand } from "./rules.ts";

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("DISCORD_TOKEN manquant : copie .env.example en .env et remplis-le.");

const barbossa = new SlashCommandBuilder()
  .setName("barbossa")
  .setDescription("Parler à Barbossa (officiers uniquement)")
  .addSubcommand((sub) =>
    sub
      .setName("ordre")
      .setDescription("Donner un ordre à Barbossa")
      .addStringOption((option) =>
        option.setName("texte").setDescription("Ex : crée un rôle privilégié").setRequired(true).setMaxLength(1000),
      ),
  )
  .addSubcommand((sub) => sub.setName("discuter").setDescription("Ouvrir un fil privé pour discuter avec Barbossa"))
  .addSubcommand((sub) =>
    sub.setName("decouvrir").setDescription("Barbossa étudie le serveur et met à jour sa mémoire"),
  )
  .addSubcommandGroup((group) =>
    group
      .setName("automod")
      .setDescription("Configurer la surveillance automatique du chat")
      .addSubcommand((sub) =>
        sub
          .setName("surveiller")
          .setDescription("Ajouter une règle")
          .addStringOption((o) =>
            o.setName("quoi").setDescription("Ex : les messages racistes").setRequired(true).setMaxLength(500),
          )
          .addStringOption((o) =>
            o.setName("actions").setDescription("Ex : supprimer le message et prévenir l'auteur en MP").setRequired(true).setMaxLength(500),
          ),
      )
      .addSubcommand((sub) => sub.setName("liste").setDescription("Voir les règles actives"))
      .addSubcommand((sub) =>
        sub
          .setName("retirer")
          .setDescription("Retirer une règle")
          .addStringOption((o) => o.setName("regle").setDescription("Id de la règle, ex. r1").setRequired(true)),
      ),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setContexts(InteractionContextType.Guild);

const commands = [barbossa, ...classicCommands];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
  ],
});

client.once(Events.ClientReady, async (ready) => {
  // Enregistrées par serveur (mise à jour immédiate) plutôt qu'en global (propagation lente côté Discord).
  await ready.application.commands.set([]);
  for (const guild of ready.guilds.cache.values()) await guild.commands.set(commands);
  logConsole("Démarrage", `⚓ ${ready.user.tag} a pris la mer sur ${ready.guilds.cache.size} serveur(s)`);
});

client.on(Events.GuildCreate, (guild) => {
  guild.commands.set(commands).catch((error) => logConsole("Erreur", `enregistrement des commandes : ${error}`));
});

async function handleBarbossa(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
  // La commande est déjà masquée aux non-admins ; on revérifie ici car c'est le code qui décide, pas Claude.
  if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "🏴‍☠️ Seuls les officiers parlent à Barbossa.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.options.getSubcommandGroup(false) === "automod") return handleAutomodCommand(interaction);
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "ordre") await handleOrder(interaction);
  else if (subcommand === "discuter") await startDiscussion(interaction);
  else if (subcommand === "decouvrir") await discover(interaction);
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.inCachedGuild()) return;
  await log(interaction.guild, "Commande", `⌨️ ${interaction.user} : \`${interaction.toString()}\` dans ${interaction.channel}`);
  try {
    if (interaction.commandName === "barbossa") await handleBarbossa(interaction);
    else await handleClassicCommand(interaction);
  } catch (error) {
    console.error(error);
    await log(interaction.guild, "Erreur", `💥 Erreur sur \`${interaction.toString()}\` : ${error instanceof Error ? error.message : error}`);
    const content = "💥 Barbossa s'est pris un boulet de canon. Réessaie dans un instant.";
    if (interaction.deferred || interaction.replied) await interaction.editReply(content).catch(() => {});
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

client.on(Events.MessageCreate, (message) => {
  moderate(message).catch((error) => logConsole("Erreur", `automod : ${error}`));
  handleThreadMessage(message).catch((error) => logConsole("Erreur", `discussion : ${error}`));
});

registerAuditLogs(client);
await client.login(token);
