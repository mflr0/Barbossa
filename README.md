# Bot hybride

Une base de bot Discord qui s'adapte à n'importe quel serveur : des commandes de modération classiques, des logs complets, un automod, et une IA (Claude, OpenAI ou Gemini) qu'on pilote en la mentionnant. Sa personnalité est déduite du serveur, et elle se forge avec le temps.

Principe : **l'IA prépare une fois, le bot rejoue sans elle.** Tout ce qui est réutilisable (réponses courantes, filtres, messages types, textes du bot) est rédigé une fois par l'IA, puis servi sans appel.

## Personnalité

- **Déduite du serveur.** Au premier démarrage, le bot étudie le serveur (nom, icône, salons, rôles, messages récents) et rédige sa **fiche** (univers, ton, références) et sa **personnalité** (nom, caractère, façon de parler). Le nom devient son pseudo sur le serveur.
- **Elle se forge avec le temps.** Chaque semaine, le **bilan** relit le serveur et ce que le bot y a appris (jargon, habitudes validées par les officiers), puis affine sa personnalité par petites touches. Le résultat arrive dans les logs avec un bouton **↩️ Annuler ce bilan** (les 10 derniers états sont gardés).
- **Textes fixes.** Ce que le bot dit sans IA (demande d'accord, budget épuisé, erreur, statut…) est neutre par défaut. L'IA le réécrit **une fois** dans le ton de la personnalité, à chaque changement de celle-ci.
- **Réglable depuis Discord.** `/personnalite` (admins) affiche le portrait et les textes fixes, et permet de modifier le portrait, de modifier un texte (vide = texte neutre), de tout réécrire dans le ton, ou de faire le bilan maintenant. On peut aussi demander : « @bot sois plus sarcastique », « appelle-toi Gertrude », « fais le bilan du serveur ».

## Parler au bot

Un admin écrit **« @bot … »** dans n'importe quel salon. Pour continuer la conversation, il suffit de **répondre** à son message.

- **Ordres** : « crée un rôle privilégié », « renomme le rôle @Modo en Gardien, couleur #3d5a80 », « crée une catégorie privée au rôle @Staff avec un salon texte et un vocal », « bannis @Spammeur pour pub », « crée un événement ce soir à 21h », « poste ce lien dans #annonces »
- **Automod** : « surveille les messages racistes : supprime-les et préviens l'auteur en MP », « montre les règles », « retire la règle r2 », « exclus #memes de la règle r1 »
- **Commandes perso** : « crée une commande /regles qui affiche le règlement ». La réponse est rédigée une fois, puis la commande répond **sans IA**.
- **Annonces** : « annonce les arrivées dans #accueil », « écris 10 messages de ban »
- **Discussion** : n'importe quoi d'autre.

Il choisit noms, couleurs, sujets et ton d'après la fiche et sa personnalité. Il retient ce qu'il apprend d'utile dans `notes.md`. Les suppressions et les bans demandent une confirmation par bouton, et il ne donne jamais la permission Administrateur.

Les échanges par mention sont visibles dans le salon : pour les ordres sensibles, utilise un salon réservé aux admins.

## Qui peut demander quoi

Le bot suit les **permissions Discord** de la personne qui lui parle. Il ne reçoit que les outils qu'elle aurait le droit d'utiliser, avec les mêmes règles de hiérarchie que Discord : on n'agit pas sur quelqu'un placé au même niveau ou au-dessus, et on n'accorde pas une permission qu'on n'a pas.

| Permission Discord | Ce qu'on peut lui demander |
|---|---|
| Exclure temporairement des membres | mute, lever un mute |
| Gérer les pseudos | renommer quelqu'un |
| Bannir des membres | bannir |
| Gérer les rôles | créer, modifier, donner ou retirer des rôles ; permissions des salons |
| Gérer les salons | créer, modifier ou supprimer des salons |
| Gérer les messages | publier un message (avec `@everyone` seulement si on a « Mentionner @everyone ») |
| Gérer les événements | créer un événement |
| Administrateur | tout, plus l'automod, les réflexes, les commandes perso, les annonces, la mémoire et la personnalité |

Sans aucune de ces permissions, on a droit à la discussion avec les membres.

**Un seul budget** : 0,30 $ par jour d'IA payante (réglable par le propriétaire dans `/status`), partagé par tout le monde. Personne ne peut en utiliser plus d'un quart, sauf le propriétaire (`OWNER_ID`). Les réflexes et les fournisseurs gratuits ne comptent pas ; les commandes classiques marchent toujours, sans IA.

**Accord préalable** : avant sa première réponse **par l'IA** à quelqu'un, le bot affiche un bouton « Lire et accepter » qui montre en privé les conditions des fournisseurs d'IA (avec les liens) et ce qu'il garde de la personne. Les réflexes, eux, répondent sans accord : rien ne part chez un fournisseur. `/cgu` réaffiche les conditions à tout moment. Retirer son accord (dans `/cgu` ou `/memoire`) demande trois confirmations, puis efface définitivement tout ce que le bot garde sur la personne ; ce qui a déjà été envoyé aux fournisseurs reste chez eux.

## Discussion avec les membres

Les membres discutent avec le bot dans les salons ouverts (« @bot ouvre la discussion dans #general »), en le mentionnant ou en lui répondant. Du gratuit au payant :

1. **Réflexes, sans IA** : des réponses toutes faites, préparées une fois par l'IA (« @bot prépare tes réflexes ») : salutations, remerciements, questions fréquentes…
2. **IA légère** : sans outils (un membre ne peut rien déclencher), réponses courtes, environ 0,0002 $ l'une sur un fournisseur payant. 5 s minimum entre deux réponses à un même membre. Au-delà du budget : phrase de repli, sans IA.
3. **Apprentissage**, à partir de ce que l'IA répond vraiment :
   - **enrichir** : un message qui aurait dû tomber sur un réflexe existant lui ajoute un motif ;
   - **nouveau** : un échange qui reviendra devient un réflexe **en attente**, activé seulement quand **un autre membre** aborde le même sujet. Chaque réflexe activé apparaît dans les logs avec un bouton « Oublier ce réflexe ».

**Mémoire**, sans appel en plus (tout s'apprend dans la réponse que l'IA écrit de toute façon) :
- **Le serveur** : un membre apprend quelque chose au bot. L'info arrive dans les logs avec ✅ Retenir / 🗑️ Refuser (admins), puis rejoint `notes.md`.
- **Chaque membre** : ce qu'un membre dit de lui-même (en parlant au bot, ou dans ses messages si l'automod les analyse) est retenu, s'il a donné son accord. 15 infos au maximum, jamais de donnée sensible.
- **Parler des membres** : quand un message cite quelqu'un, le code ajoute sa mini-fiche (rôles, ancienneté, ce qu'il a dit de lui) à la demande envoyée à l'IA.

## Automod

À la création d'une règle (par un admin, en langage naturel), l'IA choisit le mode le moins cher :
- **🔣 motifs, sans IA** (liens d'invitation, mots précis, spam…) : des expressions régulières vérifiées sur des exemples. Le leetspeak est décodé (« n3gr0 » → « negro »).
- **🧠 IA** (insultes déguisées, harcèlement, tout ce qui demande du jugement) : un modèle rapide juge les messages, avec un **🔎 pré-filtre** écrit une fois par l'IA (mots-clés et cibles possibles). Un message sans aucun signal ne part pas à l'IA : « mdr » ou « gg » ne coûtent rien. Limite : une infraction formulée sans aucun mot attendu peut passer à travers.

- Les actions (suppression, silence, MP, alerte) sont appliquées **sans IA**. Les 4 MP types de chaque règle sont rédigés une fois.
- Exclusions : un membre, un rôle, un salon ou une catégorie, pour **toutes les règles** ou pour **une seule**.
- Les messages d'un membre qui n'a pas accepté les CGU ne partent jamais chez un fournisseur gratuit (qui peut réutiliser les données) : ils passent par un payant.
- Anti-flood : verdict réutilisé pour un message identique (10 min), un MP par membre toutes les 10 min, 60 analyses par minute au plus.
- `/automod` (admins, sans IA) : les règles, leurs exclusions, la part de messages épargnés par le pré-filtre, et des boutons pour supprimer.

## Annonces, sans IA

Arrivée, départ volontaire, kick et ban : pour chaque événement, un salon et une dizaine de messages, tirés au hasard. Le nouveau venu est mentionné, celui qui part est nommé en gras. Le journal d'audit distingue un départ d'un kick. Les messages se rédigent en une fois par l'IA (« écris 10 messages d'arrivée ») ou à la main dans `/annonces` (admins) : choix du salon, ajout, modification, suppression.

## Commandes, sans IA

| Commande | Pour qui |
|---|---|
| `/ban`, `/unban`, `/kick`, `/timeout`, `/clear` | la permission Discord correspondante, revérifiée à chaque usage |
| `/automod`, `/annonces`, `/personnalite`, `/reflexes`, `/commandes` | Administrateur |
| `/memoire` | tout le monde (un membre ne voit que ce que le bot sait de lui) |
| `/status` | tout le monde (seul le propriétaire peut changer le budget) |
| `/cgu` | tout le monde |
| commandes perso | tout le monde, ou admins seulement selon la commande |

## Logs

Dans la console et dans le salon de logs, en encadrés colorés par type : commandes et mentions, actions du bot, décisions de l'automod, mémoire, personnalité et bilans, arrivées et départs, kicks, bans, messages supprimés ou modifiés, erreurs. Quand l'IA intervient, le log se termine par une petite ligne `provider: …` (le modèle, gratuit ou son coût).

## Installation

1. **Node 22.18 ou plus récent** (`node -v`).
2. **Créer le bot** sur le [Discord Developer Portal](https://discord.com/developers/applications) : New Application → onglet **Bot** → **Reset Token** (copie-le), puis active **Server Members Intent** et **Message Content Intent**. Désactive **Public Bot** pour que toi seul puisses l'inviter.
3. **Inviter le bot** en remplaçant `TON_APPLICATION_ID` (onglet General Information) :
   ```
   https://discord.com/oauth2/authorize?client_id=TON_APPLICATION_ID&scope=bot+applications.commands&permissions=1099780074516
   ```
4. Dans **Paramètres du serveur → Rôles**, glisse le rôle du bot **au-dessus** des rôles qu'il doit gérer.
5. Copie `.env.example` en `.env` et remplis-le : token Discord, `SERVER_ID` (le bot quitte tout autre serveur), `OWNER_ID`, salon de logs, fournisseurs d'IA et leurs clés.
6. Lance :
   ```bash
   npm install
   npm start
   ```
   Au premier démarrage, le bot fait son premier bilan : sa fiche et sa personnalité apparaissent dans les logs, et `/personnalite` permet de les retoucher.

## Fournisseurs d'IA

Le bot sait parler à **Anthropic (Claude)**, **OpenAI** et **Gemini**. Deux réglages dans `.env` :

```
AI_PROVIDERS=gemini,anthropic   # essayés dans l'ordre (« fournisseur:modèle » pour choisir le modèle)
AI_FREE=gemini                  # ceux utilisés en offre gratuite : hors budget
```

**Les gratuits sont essayés en premier.** Si l'un échoue (panne, quota gratuit atteint), le suivant prend le relais, et celui qui a échoué est mis de côté 5 minutes. Pour le cerveau des officiers, si une action a déjà été exécutée avant l'échec, la demande n'est pas relancée. Le pré-filtre de l'automod, écrit une seule fois, passe par un payant d'abord, pour la qualité.

Modèles par défaut : `claude-haiku-5-5` (0,10 $ / 0,50 $ par million de tokens), `gpt-6-luna` (0,10 $ / 0,50 $), `gemini-3.5-flash-lite` (gratuit avec une clé d'un projet Google **sans facturation** ; Google utilise alors les contenus pour améliorer ses produits).

## Structure

```
src/
  index.ts       démarrage, routage des événements et des interactions
  ai/            fournisseurs d'IA (Anthropic, OpenAI, Gemini) et relais entre eux
  core/          logs, stockage, budget, accords (CGU), personnalité et textes fixes
  brain/         le cerveau des officiers : outils, mentions, étude du serveur, bilan hebdomadaire
  chat/          discussion avec les membres, réflexes, infos proposées par les membres
  moderation/    automod, règles et pré-filtre, journal (arrivées, bans, messages)
  community/     annonces d'arrivée et de départ
  commands/      commandes classiques et commandes perso
  panels/        panneaux d'admin (/automod, /annonces, /memoire, /personnalite)
memoire/<id du serveur>/   tout ce que le bot sait et a appris sur ce serveur (ignoré par git)
```

`memoire/` contient des fichiers lisibles et modifiables à la main : `fiche.md`, `notes.md`, `personnalite.json`, `voix.json`, `automod.json`, `reflexes.json`, `annonces.json`, `historique.json` (états avant chaque bilan), `membres/<id>.md`…

## Limites connues

- La conversation suit la chaîne de réponses (20 messages au maximum). Une nouvelle mention sans réponse démarre une nouvelle conversation.
- Discord interdit à un bot d'accorder à un rôle une permission qu'il n'a pas lui-même.
- L'automod juge chaque message isolément, sans le fil de la conversation.
- OpenAI est implémenté avec son SDK officiel, mais pas encore testé avec une vraie clé.
- Pense à activer aussi l'**AutoMod natif** de Discord (Paramètres du serveur → AutoMod) : il bloque le spam et les mots interdits *avant* l'affichage, gratuitement.
