// Évaluation de bout en bout : node test/run.mjs [--cat hors-sujet] [--id tarif-1] [--url http://localhost:3000]
// Le serveur doit être lancé avec ANON_MAX_QUESTIONS_PER_IP_PER_DAY=1000 (sinon le plafond anonyme par IP bloque l'évaluation).
// Pour comparer des fournisseurs avec rapport détaillé : test/compare.mjs.
// ATTENTION : chaque question appelle le fournisseur de modèle (coût réel, de l'ordre de quelques centimes par question).
import fs from "node:fs";
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const URL_ = opt("--url", "http://localhost:3000");
const cat = opt("--cat"), only = opt("--id");
const questions = JSON.parse(fs.readFileSync(new URL("./questions.json", import.meta.url), "utf8")).filter((x) => (!cat || x.cat === cat) && (!only || x.id === only));

import { ask, check } from "./eval-lib.mjs";

let ok = 0;
const fails = [];
for (const t of questions) {
  let text, problems = [];
  try { text = (await ask(URL_, t.q)).text; problems.push(...check(t, text)); } catch (e) { text = ""; problems.push(`erreur : ${e.message}`); }
  const pass = problems.length === 0;
  ok += pass;
  console.log(`${pass ? "OK  " : "FAIL"} [${t.cat}] ${t.id}${pass ? "" : " — " + problems.join(" ; ")}`);
  if (!pass) fails.push({ ...t, problems, reponse: text });
  await new Promise((r) => setTimeout(r, 8000)); // reste sous la limite de débit (8 questions/min)
}
console.log(`\n${ok}/${questions.length} réussies`);
if (fails.length) {
  fs.writeFileSync(new URL("./derniers-echecs.json", import.meta.url), JSON.stringify(fails, null, 2));
  console.log("Détails des échecs : test/derniers-echecs.json (à relire : les vérifications automatiques sont grossières)");
}
process.exit(fails.length ? 1 : 0);
