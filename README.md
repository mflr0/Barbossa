# Barbossa 🏴‍☠️

Bot Discord d'administration et d'automod propulsé par Claude (Haiku 5.5).

## Ce qu'il fait

Trois sous-commandes, réservées aux admins :
- **`/barbossa decouvrir`** : il étudie le serveur (structure, icône, ~50 messages récents) et écrit sa fiche de mémoire dans `memoire/<id du serveur>/fiche.md`. Relance-la après un changement de DA.
- **`/barbossa discuter`** : ouvre un fil privé où il répond à chaque message, avec le fil de la conversation. Il peut aussi agir si tu le lui demandes, avec les mêmes confirmations.
- **`/barbossa ordre texte:…`** : un ordre ponctuel en langage naturel.

Il retient aussi ce qu'il apprend d'utile au fil des échanges dans `memoire/<id du serveur>/notes.md`. Les deux fichiers se modifient à la main.

Exemples d'ordres :
- « crée un rôle privilégié »
- « crée une catégorie pour les officiers avec un salon texte et un vocal, privés au rôle @Officier »
- « donne le rôle @Vigie à @Jean »
- « bannis @Spammeur pour pub »

Il choisit lui-même les noms, couleurs et sujets, et adapte son ton, en déduisant l'ambiance du serveur à chaque commande : nom, description, icône, noms et couleurs des salons et rôles. Si tu changes la DA du serveur, il suit sans rien modifier. Les suppressions et les bannissements demandent une confirmation par bouton. Il ne donne jamais la permission Administrateur.

**Automod configurable en langage naturel** :
- `/barbossa automod surveiller quoi:"les messages racistes" actions:"supprimer et prévenir l'auteur en MP"` : l'IA traduit ta demande **une seule fois** en règle (supprimer, silence, MP, alerte) et rédige 4 MP types. Elle te montre le résultat.
- `/barbossa automod liste` et `/barbossa automod retirer regle:r1`.
- Ensuite, chaque message (hors bots et modérateurs) passe par Haiku, qui dit seulement quelle règle est enfreinte. Les actions et les MP (tirés au hasard parmi les 4) sont appliqués **sans IA**.
- Sans règle configurée, deux règles par défaut s'appliquent : `grave` (suppression et silence 10 min) et `suspect` (alerte seulement).
- Anti-flood : un message identique déjà jugé dans les 10 dernières minutes réutilise le verdict sans appel API, au plus un MP par membre toutes les 10 min, et 60 analyses par minute au maximum.
- Les messages modifiés sont revérifiés. Barbossa ne bannit jamais automatiquement, et le classifieur n'a accès à aucune action.

**Commandes classiques, sans IA** : `/ban`, `/unban`, `/kick`, `/timeout` (0 minute pour lever le silence) et `/clear`. Chacune est réservée aux membres qui ont la permission Discord correspondante, et refuse si la cible est placée au même niveau ou plus haut que l'auteur de la commande.

**Logs** dans la console et dans le salon de logs : commandes utilisées, actions de Barbossa, décisions de l'automod, erreurs, arrivées et départs, messages supprimés ou modifiés, bans et débans (avec qui et pourquoi). La console affiche aussi le coût estimé de chaque appel à Claude.

## Installation

1. **Node 22.18 ou plus récent** (`node -v`).
2. **Créer le bot** sur le [Discord Developer Portal](https://discord.com/developers/applications) : New Application → onglet **Bot** → **Reset Token** (copie-le), et active **Server Members Intent** et **Message Content Intent** plus bas sur la même page.
3. **Inviter le bot** en remplaçant `TON_APPLICATION_ID` (onglet General Information) :
   ```
   https://discord.com/oauth2/authorize?client_id=TON_APPLICATION_ID&scope=bot+applications.commands&permissions=1099780074516
   ```
   Permissions demandées : voir les salons, envoyer des messages, gérer les messages, gérer les salons, gérer les rôles, bannir, exclure temporairement.
4. Dans **Paramètres du serveur → Rôles**, glisse le rôle de Barbossa **au-dessus** des rôles qu'il doit gérer. Discord l'empêche de toucher aux rôles et aux membres placés plus haut que lui.
5. Copie `.env.example` en `.env` et remplis-le.
6. Lance :
   ```bash
   npm install
   npm start
   ```

## Budget

Ordre de grandeur pour ~2 000 messages et ~10 commandes par jour, tout sur Haiku 5.5 (0,10 $ / 0,50 $ par million de tokens) : **quelques dollars par mois**.

- Fixe une limite de dépense dans la [Console Anthropic](https://platform.claude.com) (Settings → Limits). C'est ta protection contre un bug.
- Au-delà de 60 messages analysés par minute (raid, flood), l'automod se met en pause et laisse l'AutoMod natif de Discord gérer (`MAX_CHECKS_PER_MINUTE` dans `src/automod.ts`).
- Si Haiku se montre un peu juste sur les commandes admin, mets `ADMIN_MODEL=claude-sonnet-5-5` (environ 20 fois le prix de Haiku) ou `claude-opus-5-5` dans `.env`.

## Personnaliser

| Quoi | Où |
|---|---|
| Imposer une ambiance qui prime sur celle du serveur | renomme `lore.example.md` en `lore.md` et adapte-le |
| Photo de profil du bot | `avatar.jpg`, à déposer dans le Developer Portal → Bot → Icon |
| Ce qui est toléré ou sanctionné par l'automod | `SYSTEM` dans `src/automod.ts` |
| Durée du silence, plafond par minute | constantes en haut de `src/automod.ts` |
| Ajouter une action (retirer un rôle, renommer un salon…) | un `betaZodTool` de plus dans `src/tools.ts` |

## Limites connues

- Un ordre = un échange. Si Barbossa demande une précision, relance `/barbossa` avec l'info.
- Discord interdit à un bot d'accorder à un rôle une permission qu'il n'a pas lui-même. Si une création de rôle échoue pour ça, Barbossa te le dira.
- L'automod juge chaque message isolément, sans le fil de la conversation, et ne revérifie pas les messages modifiés.
- Pense à activer aussi l'**AutoMod natif** de Discord (Paramètres du serveur → AutoMod) : il bloque le spam et les mots interdits *avant* l'affichage, gratuitement.
# Barbossa
