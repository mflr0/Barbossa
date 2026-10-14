import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type StringSelectMenuInteraction,
} from "discord.js";
import { botName } from "../core/server.ts";
import { prefilter } from "../moderation/automod.ts";
import { log } from "../core/log.ts";
import { getAutomod, modeOf, removeRule, setExclusion, type Exclusions, type Rule } from "../moderation/rules.ts";

// /automod : panneau sans IA pour voir les règles et exclusions, et les retirer d'un clic.
// Les boutons portent leur action dans leur customId, donc le panneau marche même après un redémarrage.
export const automodCommand = new SlashCommandBuilder()
  .setName("automod")
  .setDescription("Voir et gérer les règles d'automod")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setContexts(InteractionContextType.Guild);

const MAX_RULE_BUTTONS = 20; // 4 rangées de 5 boutons ; la 5e rangée accueille le menu des exclusions.

function actionsOf(rule: Rule): string {
  return (
    [
      rule.delete && "suppression",
      rule.timeoutMinutes > 0 && `silence ${rule.timeoutMinutes} min`,
      rule.dm && `MP (${rule.dmTemplates.length} variantes)`,
      rule.alert && "alerte",
    ]
      .filter(Boolean)
      .join(", ") || "aucune action"
  );
}

function exclusionLabel(guild: Guild, kind: keyof Exclusions, id: string): string {
  if (kind === "users") return `👤 ${guild.members.cache.get(id)?.displayName ?? guild.client.users.cache.get(id)?.username ?? id}`;
  if (kind === "roles") return `🎭 ${guild.roles.cache.get(id)?.name ?? id}`;
  return `# ${guild.channels.cache.get(id)?.name ?? id}`;
}

async function panel(guild: Guild) {
  const { rules, exclusions } = await getAutomod(guild.id);
  const embed = new EmbedBuilder().setTitle("🛡️ Automod").setColor(0xc9a227);
  if (!rules.length) embed.setDescription(`Aucune règle : l'automod est en pause.\nAjoute-en une avec « @${botName(guild)} surveille… ».`);
  // Toutes les exclusions : communes (rule vide) ou propres à une règle.
  const listOf = (ex: Exclusions, rule: string) => (Object.keys(ex) as (keyof Exclusions)[]).flatMap((kind) => ex[kind].map((id) => ({ kind, id, rule })));
  for (const rule of rules.slice(0, 24)) {
    const own = rule.exclusions ? listOf(rule.exclusions, rule.id) : [];
    const ownText = own.length ? `\n⛔ Sauf : ${own.map(({ kind, id }) => exclusionLabel(guild, kind, id)).join(", ")}` : "";
    embed.addFields({ name: rule.id, value: `${modeOf(rule)}\n${rule.watch.slice(0, 800)}\n→ ${actionsOf(rule)}${ownText}`.slice(0, 1024) });
  }
  const excluded = [...listOf(exclusions, ""), ...rules.flatMap((r) => (r.exclusions ? listOf(r.exclusions, r.id) : []))];
  const common = excluded.filter((e) => !e.rule);
  const checked = prefilter.analyzed + prefilter.skipped;
  if (checked) {
    const share = Math.round((prefilter.skipped / checked) * 100);
    embed.addFields({ name: "Pré-filtre", value: `Depuis le démarrage : ${prefilter.skipped} message(s) sur ${checked} épargné(s) à l'IA (${share} %)` });
  }
  embed.addFields({
    name: "Exclusions (toutes les règles)",
    value: common.length ? common.map(({ kind, id }) => exclusionLabel(guild, kind, id)).join("\n").slice(0, 1024) : "aucune",
  });

  const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];
  const buttons = rules.slice(0, MAX_RULE_BUTTONS).map((rule) =>
    new ButtonBuilder().setCustomId(`automod:ask:${rule.id}`).setLabel(`🗑️ ${rule.id}`).setStyle(ButtonStyle.Danger),
  );
  for (let i = 0; i < buttons.length; i += 5) components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)));
  if (excluded.length) {
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("automod:unexclude")
          .setPlaceholder("Retirer une exclusion…")
          .addOptions(
            excluded.slice(0, 25).map(({ kind, id, rule }) => ({
              label: `${rule || "toutes"} · ${exclusionLabel(guild, kind, id)}`.slice(0, 100),
              value: `${kind}:${id}:${rule}`,
            })),
          ),
      ),
    );
  }
  return { content: "", embeds: [embed], components };
}

export async function showAutomodPanel(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
  await interaction.reply({ ...(await panel(interaction.guild)), flags: MessageFlags.Ephemeral });
}

// Clics sur le panneau : demander confirmation, supprimer une règle, revenir, retirer une exclusion.
export async function handleAutomodPanel(interaction: ButtonInteraction<"cached"> | StringSelectMenuInteraction<"cached">): Promise<void> {
  if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "Réservé aux admins.", flags: MessageFlags.Ephemeral });
    return;
  }
  const [, action, arg] = interaction.customId.split(":");

  if (interaction.isStringSelectMenu() && action === "unexclude") {
    const [kind, id, rule] = interaction.values[0]!.split(":") as [keyof Exclusions, string, string];
    const label = exclusionLabel(interaction.guild, kind, id);
    await setExclusion(interaction.guildId, kind, id, false, rule || undefined);
    await log(interaction.guild, "Automod", `🙈 ${interaction.user} a retiré l'exclusion ${rule ? `de la règle ${rule}` : "de toutes les règles"} : ${label}`);
    await interaction.update(await panel(interaction.guild));
    return;
  }

  if (action === "ask" && arg) {
    const confirm = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`automod:delete:${arg}`).setLabel(`Supprimer ${arg}`).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("automod:back").setLabel("Annuler").setStyle(ButtonStyle.Secondary),
    );
    await interaction.update({ content: `⚠️ Supprimer la règle **${arg}** ? Ses MP types seront perdus.`, components: [confirm] });
    return;
  }

  if (action === "delete" && arg) {
    const rule = await removeRule(interaction.guildId, arg);
    if (rule) await log(interaction.guild, "Automod", `🗑️ ${interaction.user} a supprimé la règle d'automod **${rule.id}** (${rule.watch})`);
  }
  // "delete" et "back" reviennent au panneau à jour.
  await interaction.update(await panel(interaction.guild));
}
