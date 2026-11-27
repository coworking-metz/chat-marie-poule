// Évaluation de bout en bout : node test/run.mjs [--cat hors-sujet] [--id tarif-1] [--url http://localhost:3000]
// Le serveur doit être lancé avec ANON_MAX_QUESTIONS_PER_IP_PER_DAY=1000 (sinon le plafond anonyme par IP bloque l'évaluation).
// ATTENTION : chaque question appelle l'API Anthropic (coût réel, de l'ordre de quelques centimes par question).
import fs from "node:fs";
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const URL_ = opt("--url", "http://localhost:3000");
const cat = opt("--cat"), only = opt("--id");
const questions = JSON.parse(fs.readFileSync(new URL("./questions.json", import.meta.url), "utf8")).filter((x) => (!cat || x.cat === cat) && (!only || x.id === only));

const REFUS = /(ne peux répondre qu|uniquement|hors de mon périmètre|je ne peux pas|je ne suis pas en mesure|concernent? le coworking|questions? sur le coworking)/i;

async function ask(q) {
  const res = await fetch(`${URL_}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: q }] }) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = await res.text();
  let text = "";
  for (const b of raw.split("\n\n")) {
    const ev = /^event: (\w+)/m.exec(b)?.[1], d = /^data: (.*)$/m.exec(b)?.[1];
    if (ev === "delta") text += JSON.parse(d).text;
    if (ev === "error") throw new Error(JSON.parse(d).text);
  }
  return text;
}

let ok = 0;
const fails = [];
for (const t of questions) {
  let text, problems = [];
  try { text = await ask(t.q); } catch (e) { text = ""; problems.push(`erreur : ${e.message}`); }
  if (!text) problems.push("réponse vide");
  if (t.refus && !REFUS.test(text)) problems.push("refus attendu, non détecté");
  for (const w of t.interdit ?? []) if (text.toLowerCase().includes(w.toLowerCase())) problems.push(`contient « ${w} »`);
  for (const r of t.interdit_regex ?? []) if (new RegExp(r, "i").test(text)) problems.push(`motif sensible /${r}/`);
  for (const w of t.attendu ?? []) if (!text.toLowerCase().includes(w.toLowerCase())) problems.push(`devrait contenir « ${w} »`);
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
