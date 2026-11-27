// Tests hors ligne (sans appel à l'API) : corpus, outils, validation des entrées.
import assert from "node:assert/strict";
import fs from "node:fs";
import { chercher, lireFiche, nombreFiches, indexText } from "../src/corpus.js";
import { cleanMessages, MAX_QUESTION_CHARS } from "../src/limits.js";
import { systemPrompt } from "../src/prompt.js";

const corpusPresent = fs.existsSync(new URL("../context/INDEX.md", import.meta.url));
if (corpusPresent) {
  assert.ok(nombreFiches() >= 40, "le corpus doit contenir des fiches");
  assert.ok(indexText().includes("## Catalogue des fiches"));
  assert.ok(systemPrompt().includes("coworking-metz.fr/contact"));

  // lire_fiche : chemins du catalogue valides, traversée de répertoire refusée
  assert.equal(lireFiche("themes/tarifs-et-abonnements.md").ok, true);
  assert.equal(lireFiche("../.env").ok, false);
  assert.equal(lireFiche("../../etc/passwd").ok, false);
  assert.equal(lireFiche("_SPEC.md").ok, false);
  assert.equal(lireFiche("INDEX.md").ok, false);
  // chaque chemin cité dans le catalogue existe
  const chemins = [...indexText().matchAll(/`((?:annees|themes|sources-web|images)\/[^`]+\.md)`/g)].map((m) => m[1]);
  assert.ok(chemins.length > 30);
  for (const c of new Set(chemins)) assert.equal(lireFiche(c).ok, true, `fiche du catalogue introuvable : ${c}`);

  // chercher
  assert.ok(chercher("tarifs abonnement").texte.includes("tarifs"));
  assert.equal(chercher("").ok, false);
} else {
  console.log("corpus context/ absent (non publié) : tests du corpus ignorés");
}

// cleanMessages
assert.ok(cleanMessages([]).error);
assert.ok(cleanMessages([{ role: "assistant", content: "x" }]).error);
assert.ok(cleanMessages([{ role: "user", content: "a".repeat(MAX_QUESTION_CHARS + 1) }]).error);
const h = cleanMessages([{ role: "user", content: "a" }, { role: "user", content: "b" }, { role: "system", content: "c" }]);
assert.deepEqual(h.messages.map((m) => m.role), ["user"]); // rôle inconnu -> user, fusion des consécutifs
assert.equal(cleanMessages([{ role: "user", content: "Bonjour" }]).messages.length, 1);
console.log("tests hors ligne : OK");
