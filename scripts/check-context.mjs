#!/usr/bin/env node
// Contrôles automatiques du corpus context/ : couverture des sources, taille, en-têtes, motifs sensibles.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ctx = join(root, "context");
const walk = (d) => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const files = walk(ctx).filter((f) => f.endsWith(".md"));
const corpus = files.filter((f) => !relative(ctx, f).split("/").some((s) => s.startsWith("_")) && !f.endsWith("INDEX.md"));
let problems = 0;
const fail = (m) => { problems++; console.log("✗ " + m); };
const ok = (m) => console.log("✓ " + m);

// 1. En-têtes et taille
let chars = 0;
for (const f of corpus) {
  const t = readFileSync(f, "utf8");
  chars += t.length;
  if (!/^---\ntitre: .+\nperiode: .+/m.test(t) || !/^sources:/m.test(t)) fail(`en-tête manquant ou incomplet : ${relative(root, f)}`);
}
const tokens = Math.round(chars / 3.5);
ok(`${corpus.length} fichiers de corpus, ${chars} caractères, ≈ ${tokens} tokens (estimation chars/3,5)`);
if (tokens > 150000) fail(`corpus trop gros pour tout charger dans le prompt (> 150 000 tokens)`);

// 2. Couverture : chaque source (docs + pages web) apparaît dans un index d'agent
const idx = existsSync(join(ctx, "_index")) ? readdirSync(join(ctx, "_index")).map((f) => readFileSync(join(ctx, "_index", f), "utf8")).join("\n") : "";
const docs = existsSync(join(root, "extracted", "_inventory.json")) ? JSON.parse(readFileSync(join(root, "extracted", "_inventory.json"), "utf8")) : [];
const missing = docs.filter((r) => !idx.includes(r.path) && !idx.includes(r.path.split("/").pop()));
if (missing.length) { fail(`${missing.length} fichier(s) docs/ absent(s) des index (ex. ${missing.slice(0, 5).map((r) => r.path).join(" ; ")})`); } else ok("tous les fichiers docs/ figurent dans un index");
const web = existsSync(join(root, "extracted", "web", "_pages.json")) ? JSON.parse(readFileSync(join(root, "extracted", "web", "_pages.json"), "utf8")) : [];
const wmiss = web.filter((r) => r.status === "ok" && !idx.includes(r.url) && !idx.includes(new URL(r.url).pathname));
if (wmiss.length) { fail(`${wmiss.length} page(s) web absente(s) des index (ex. ${wmiss.slice(0, 5).map((r) => r.url).join(" ; ")})`); } else if (web.length) ok("toutes les pages web figurent dans un index");

// 3. Motifs sensibles (RGPD) dans le corpus
const rules = [
  ["e-mail", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => /^contact@coworking-metz\.fr$/i.test(m)],
  ["téléphone", /(?:\+33|0033|\b0)[1-9](?:[ .-]?\d{2}){4}\b/g, () => false],
  ["IBAN", /\bFR\d{2}(?: ?[0-9A-Z]{4}){5}(?: ?[0-9A-Z]{1,3})?\b/g, () => false],
  ["n° sécu", /\b[12] ?\d{2} ?\d{2} ?\d{2} ?\d{3} ?\d{3} ?\d{2}\b/g, () => false],
];
for (const f of corpus) {
  const t = readFileSync(f, "utf8");
  for (const [name, re, allow] of rules) {
    const hits = (t.match(re) || []).filter((m) => !allow(m));
    if (hits.length) fail(`${name} dans ${relative(root, f)} : ${hits.slice(0, 3).join(", ")}${hits.length > 3 ? " …" : ""}`);
  }
}
console.log(problems ? `\n${problems} problème(s)` : "\nTout est conforme.");
process.exit(problems ? 1 : 0);
