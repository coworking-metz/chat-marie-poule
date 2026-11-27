#!/usr/bin/env node
// Assemble context/_TRACE.md (traçabilité : une ligne par source) à partir des index d'agents (context/_index/*.md) + de l'inventaire.
// NB : context/INDEX.md (le « parent » lu par l'IA : socle + catalogue) est rédigé à la main/par agent, pas généré ici.
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "context", "_index");
const parts = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : [];
const docs = existsSync(join(root, "extracted", "_inventory.json")) ? JSON.parse(readFileSync(join(root, "extracted", "_inventory.json"), "utf8")) : [];
const web = existsSync(join(root, "extracted", "web", "_pages.json")) ? JSON.parse(readFileSync(join(root, "extracted", "web", "_pages.json"), "utf8")) : [];

let out = `# Traçabilité du corpus Marie-Poule\n\n> Généré par \`npm run build:index\` (non lu par l'IA). Ne pas éditer à la main : modifier les index d'agents dans \`context/_index/\`.\n\n`;
out += `- Sources \`docs/\` : **${docs.length}** fichiers inventoriés.\n- Pages web (sitemap) : **${web.length}** URL.\n- Index d'agents : ${parts.length} fichier(s).\n\n`;
for (const f of parts) {
  out += `\n---\n\n## ${f.replace(/\.md$/, "")}\n\n` + readFileSync(join(dir, f), "utf8").replace(/^# .*\n/, "").trim() + "\n";
}
writeFileSync(join(root, "context", "_TRACE.md"), out);
console.log(`context/_TRACE.md écrit (${parts.length} index fusionnés).`);
