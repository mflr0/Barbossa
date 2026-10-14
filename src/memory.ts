import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";

// Mémoire persistante par serveur, en fichiers texte modifiables à la main :
// - memoire/<id du serveur>/fiche.md : la fiche écrite par /barbossa decouvrir (remplacée à chaque découverte)
// - memoire/<id du serveur>/notes.md : ce que Barbossa retient au fil des échanges (outil remember)
const ROOT = new URL("../memoire/", import.meta.url);
const dir = (guildId: string) => new URL(`${guildId}/`, ROOT);

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

export async function saveProfile(guildId: string, profile: string): Promise<void> {
  await mkdir(dir(guildId), { recursive: true });
  await writeFile(new URL("fiche.md", dir(guildId)), `${profile.trim()}\n`);
}

export async function addNote(guildId: string, note: string): Promise<void> {
  await mkdir(dir(guildId), { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  await appendFile(new URL("notes.md", dir(guildId)), `- ${date} : ${note.replaceAll("\n", " ").trim()}\n`);
}
