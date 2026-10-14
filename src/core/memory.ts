import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";

// Mémoire persistante par serveur, en fichiers texte modifiables à la main :
// - memoire/<id du serveur>/fiche.md : la fiche écrite par l'étude du serveur (remplacée à chaque bilan)
// - memoire/<id du serveur>/notes.md : ce que le bot retient au fil des échanges (outil remember)
// - memoire/<id du serveur>/*.json : personnalité, textes fixes, automod, réflexes, annonces, accords…
const ROOT = new URL("../../memoire/", import.meta.url);
const dir = (guildId: string) => new URL(`${guildId}/`, ROOT);

// Verrou par fichier : deux modifications simultanées (par exemple deux outils que l'IA appelle en parallèle)
// passent l'une après l'autre, au lieu que la seconde écrase la première.
const locks = new Map<string, Promise<unknown>>();

export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
  locks.set(key, run.catch(() => {}));
  return run;
}

async function readIfExists(url: URL): Promise<string> {
  return (await readFile(url, "utf8").catch(() => "")).trim();
}

export async function readMemory(guildId: string): Promise<{ profile: string; notes: string }> {
  const [profile, notes] = await Promise.all([
    readIfExists(new URL("fiche.md", dir(guildId))),
    readIfExists(new URL("notes.md", dir(guildId))),
  ]);
  return { profile, notes };
}

// --- Mémoire de chaque membre : ce qu'il a dit de lui-même, utilisée seulement quand le bot lui parle ---
// memoire/<id du serveur>/membres/<id du membre>.md
const MAX_MEMBER_NOTES = 15;
const memberFile = (guildId: string, userId: string) => new URL(`membres/${userId}.md`, dir(guildId));

export async function readMemberNotes(guildId: string, userId: string): Promise<string> {
  return readIfExists(memberFile(guildId, userId));
}

// Ce qui ne doit jamais entrer en mémoire : liens, invitations, mentions.
export const LINK_OR_MENTION = /https?:\/\/|www\.|discord(?:\.gg|app\.com\/invite|\.com\/invite)|<[@#]|@everyone|@here/i;

export async function addMemberNote(guildId: string, userId: string, note: string): Promise<void> {
  await withLock(`${guildId}/membres/${userId}`, async () => {
    const line = `- ${note.replaceAll("\n", " ").trim()}`;
    const lines = (await readMemberNotes(guildId, userId)).split("\n").filter(Boolean);
    if (lines.some((l) => l.toLowerCase() === line.toLowerCase())) return;
    await mkdir(new URL("membres/", dir(guildId)), { recursive: true });
    await writeFile(memberFile(guildId, userId), `${[...lines, line].slice(-MAX_MEMBER_NOTES).join("\n")}\n`);
  });
}

export async function forgetMember(guildId: string, userId: string): Promise<void> {
  await withLock(`${guildId}/membres/${userId}`, () => rm(memberFile(guildId, userId), { force: true }));
}

export async function readJson<T>(guildId: string, name: string, fallback: T): Promise<T> {
  const raw = await readFile(new URL(name, dir(guildId)), "utf8").catch(() => null);
  return raw ? (JSON.parse(raw) as T) : fallback;
}

export async function writeJson(guildId: string, name: string, data: unknown): Promise<void> {
  await mkdir(dir(guildId), { recursive: true });
  await writeFile(new URL(name, dir(guildId)), `${JSON.stringify(data, null, 2)}\n`);
}

export async function saveProfile(guildId: string, profile: string): Promise<void> {
  await mkdir(dir(guildId), { recursive: true });
  await writeFile(new URL("fiche.md", dir(guildId)), `${profile.trim()}\n`);
}

export async function addNote(guildId: string, note: string): Promise<void> {
  await withLock(`${guildId}/notes.md`, async () => {
    await mkdir(dir(guildId), { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    await appendFile(new URL("notes.md", dir(guildId)), `- ${date} : ${note.replaceAll("\n", " ").trim()}\n`);
  });
}

export async function listNotes(guildId: string): Promise<string[]> {
  return (await readIfExists(new URL("notes.md", dir(guildId)))).split("\n").filter(Boolean);
}

// Retire une info de la mémoire du serveur (par sa position dans la liste). Renvoie la ligne retirée.
export async function removeNote(guildId: string, index: number): Promise<string | null> {
  return withLock(`${guildId}/notes.md`, async () => {
    const lines = await listNotes(guildId);
    const [removed] = lines.splice(index, 1);
    if (removed === undefined) return null;
    await writeFile(new URL("notes.md", dir(guildId)), lines.length ? `${lines.join("\n")}\n` : "");
    return removed;
  });
}

export async function countKnownMembers(guildId: string): Promise<number> {
  return (await readdir(new URL("membres/", dir(guildId))).catch(() => [])).length;
}
