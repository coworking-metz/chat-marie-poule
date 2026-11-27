// Banc de comparaison de fournisseurs de modèle.
//   Mesure : node test/compare.mjs --url http://localhost:3100 [--label sonnet-5-5] [--cat regles] [--id chaise-1] [--delay 0]
//   Écart  : node test/compare.mjs --diff test/rapports/a.json test/rapports/b.json [c.json …]
// Le serveur testé doit être lancé avec : ANON_MAX_QUESTIONS_PER_IP_PER_DAY=1000 RATE_LIMIT_PER_MIN=1000 EXPOSE_USAGE=1
// (plafond anonyme et débit levés ; EXPOSE_USAGE=1 fait remonter tokens et coût estimé de chaque question).
// Écrit test/rapports/<label>-<date>.json et .md (dossier gitignoré). Chaque question appelle le modèle : coût réel.
import fs from "node:fs";
import { ask, check, metrics } from "./eval-lib.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const DIR = new URL("./rapports/", import.meta.url);
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
const usd = (x) => `${x.toFixed(4)} $`;

function summarize(rows) {
  const ok = rows.filter((r) => r.ok), t = (f) => rows.map(f).filter((v) => v != null);
  const cat = {};
  for (const r of rows) { (cat[r.cat] ??= { n: 0, ok: 0 }).n++; cat[r.cat].ok += r.ok; }
  const rule = (f) => rows.filter(f);
  const anch = rule((r) => r.ancre_attendue);
  return {
    questions: rows.length, reussies: ok.length, erreurs: rows.filter((r) => r.erreur).length, par_categorie: cat,
    lignes_moy: +avg(t((r) => r.lignes)).toFixed(1), caracteres_moy: Math.round(avg(t((r) => r.caracteres))), liens_moy: +avg(t((r) => r.liens)).toFixed(2),
    ancres_ok: anch.filter((r) => r.liens_ancres_reglement > 0).length, ancres_attendues: anch.length,
    refus_ok: rule((r) => r.refus_attendu).filter((r) => r.ok).length, refus_attendus: rule((r) => r.refus_attendu).length,
    ttft_med_ms: Math.round(pct(t((r) => r.ttft_ms), 0.5)), ttft_p90_ms: Math.round(pct(t((r) => r.ttft_ms), 0.9)),
    total_med_ms: Math.round(pct(t((r) => r.total_ms), 0.5)), total_p90_ms: Math.round(pct(t((r) => r.total_ms), 0.9)),
    tokens_in_moy: Math.round(avg(t((r) => r.tokens_in))), tokens_out_moy: Math.round(avg(t((r) => r.tokens_out))),
    cout_total_usd: +rows.reduce((s, r) => s + (r.cout_usd ?? 0), 0).toFixed(4), cout_moy_usd: +avg(t((r) => r.cout_usd)).toFixed(5),
  };
}

function markdown(rep) {
  const s = rep.synthese, L = [];
  L.push(`# Rapport ${rep.label}`, "", `- Fournisseur : ${rep.provider} / ${rep.model} — ${rep.date}`, `- ${s.reussies}/${s.questions} réussies, ${s.erreurs} erreur(s) ; coût estimé ${usd(s.cout_total_usd)} (${usd(s.cout_moy_usd)}/question)`, "",
    "| id | cat | OK | lignes | car. | liens | ancres | refus | 1er token | total | tok in/out | coût | problèmes |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rep.resultats) L.push(`| ${r.id} | ${r.cat} | ${r.ok ? "oui" : "NON"} | ${r.lignes ?? ""} | ${r.caracteres ?? ""} | ${r.liens ?? ""} | ${r.liens_ancres_reglement ?? ""} | ${r.refus_detecte ? "oui" : ""} | ${r.ttft_ms ?? ""} | ${r.total_ms ?? ""} | ${r.tokens_in ?? ""}/${r.tokens_out ?? ""} | ${r.cout_usd != null ? r.cout_usd.toFixed(4) : ""} | ${(r.problemes ?? []).join(" ; ").replace(/\|/g, "/")} |`);
  L.push("", "## Réponses", "");
  for (const r of rep.resultats) L.push(`### ${r.id} — ${r.q}`, "", ...(r.reponse ?? "").split("\n").map((l) => `> ${l}`), "");
  return L.join("\n");
}

/** Tableau comparatif Markdown de plusieurs rapports. */
function diff(files) {
  const reps = files.map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
  const names = reps.map((r) => `${r.label}`);
  const row = (name, f) => `| ${name} | ${reps.map((r) => f(r.synthese, r)).join(" | ")} |`;
  const L = [`| Mesure | ${names.join(" | ")} |`, `|---|${names.map(() => "---").join("|")}|`,
    row("Modèle", (s, r) => `${r.provider}/${r.model}`),
    row("Questions réussies", (s) => `${s.reussies}/${s.questions}`),
    row("Erreurs", (s) => s.erreurs),
    row("Refus attendus obtenus", (s) => `${s.refus_ok}/${s.refus_attendus}`),
    row("Lien ancré du règlement (si attendu)", (s) => `${s.ancres_ok}/${s.ancres_attendues}`),
    row("Lignes par réponse (moy.)", (s) => s.lignes_moy),
    row("Caractères par réponse (moy.)", (s) => s.caracteres_moy),
    row("Liens par réponse (moy.)", (s) => s.liens_moy),
    row("1er token médian / p90 (ms)", (s) => `${s.ttft_med_ms} / ${s.ttft_p90_ms}`),
    row("Durée totale médiane / p90 (ms)", (s) => `${s.total_med_ms} / ${s.total_p90_ms}`),
    row("Tokens entrée / sortie (moy.)", (s) => `${s.tokens_in_moy} / ${s.tokens_out_moy}`),
    row("Coût par question", (s) => usd(s.cout_moy_usd)),
    row("Coût total", (s) => usd(s.cout_total_usd))];
  const cats = [...new Set(reps.flatMap((r) => Object.keys(r.synthese.par_categorie)))];
  for (const c of cats) L.push(row(`Réussite « ${c} »`, (s) => (s.par_categorie[c] ? `${s.par_categorie[c].ok}/${s.par_categorie[c].n}` : "-")));
  const ids = [...new Set(reps.flatMap((r) => r.resultats.map((x) => x.id)))];
  const divergent = ids.filter((id) => new Set(reps.map((r) => r.resultats.find((x) => x.id === id)?.ok)).size > 1);
  L.push("", divergent.length ? "Questions où les résultats divergent :" : "Aucune divergence de réussite entre les rapports.", "");
  for (const id of divergent) L.push(`- ${id} : ${reps.map((r, i) => { const x = r.resultats.find((y) => y.id === id); return `${names[i]} ${x ? (x.ok ? "OK" : "NON — " + (x.problemes ?? []).join(" ; ")) : "-"}`; }).join(" | ")}`);
  return L.join("\n");
}

if (args.includes("--diff")) {
  const files = args.slice(args.indexOf("--diff") + 1).filter((a) => !a.startsWith("--"));
  if (files.length < 2) { console.error("Usage : node test/compare.mjs --diff a.json b.json [...]"); process.exit(2); }
  console.log(diff(files));
  process.exit(0);
}

const URL_ = opt("--url", "http://localhost:3000");
const cat = opt("--cat"), only = opt("--id"), delay = Number(opt("--delay", 0));
const questions = JSON.parse(fs.readFileSync(new URL("./questions.json", import.meta.url), "utf8")).filter((x) => (!cat || x.cat === cat) && (!only || x.id === only));
const health = await fetch(`${URL_}/api/health`).then((r) => r.json()).catch(() => null);
if (!health) { console.error(`Serveur injoignable : ${URL_}`); process.exit(2); }
const label = opt("--label", `${health.provider}-${health.model}`.replace(/[^\w.-]+/g, "_"));

const resultats = [];
for (const t of questions) {
  const row = { id: t.id, cat: t.cat, q: t.q, refus_attendu: !!(t.refus || t.refus_ou_inconnu), ancre_attendue: !!t.ancre_reglement };
  try {
    const a = await ask(URL_, t.q);
    Object.assign(row, metrics(a.text), { ttft_ms: a.ttft_ms, total_ms: a.total_ms, tokens_in: a.usage.input, tokens_out: a.usage.output, cout_usd: a.usage.usd, reponse: a.text });
    row.problemes = check(t, a.text);
  } catch (e) {
    row.erreur = e.message; row.problemes = [`erreur : ${e.message}`]; row.reponse = "";
    if (/plafond anonyme/.test(e.message)) { console.error(e.message); process.exit(2); }
  }
  row.ok = row.problemes.length === 0;
  resultats.push(row);
  console.log(`${row.ok ? "OK  " : "FAIL"} [${t.cat}] ${t.id} ${row.total_ms ?? "-"} ms ${row.cout_usd != null ? row.cout_usd.toFixed(4) + " $" : ""}${row.ok ? "" : " — " + row.problemes.join(" ; ")}`);
  if (delay) await new Promise((r) => setTimeout(r, delay));
}
const rep = { label, provider: health.provider, model: health.model, date: new Date().toISOString(), url: URL_, synthese: summarize(resultats), resultats };
fs.mkdirSync(DIR, { recursive: true });
const base = `${label}-${rep.date.slice(0, 19).replace(/[:T]/g, "-")}`;
fs.writeFileSync(new URL(`${base}.json`, DIR), JSON.stringify(rep, null, 2));
fs.writeFileSync(new URL(`${base}.md`, DIR), markdown(rep));
const s = rep.synthese;
console.log(`\n${s.reussies}/${s.questions} réussies, ${s.erreurs} erreur(s), coût estimé ${usd(s.cout_total_usd)}\nRapport : test/rapports/${base}.json (+ .md)`);
