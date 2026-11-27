// Tests hors ligne du fournisseur OpenAI-compatible contre un faux serveur (aucune clé, aucun coût, corpus factice).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeOpenAI } from "./fake-openai.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mp-corpus-"));
fs.writeFileSync(path.join(dir, "INDEX.md"), "# Index factice\n## Catalogue des fiches\n- `themes/tarifs.md`\n");
fs.mkdirSync(path.join(dir, "themes"));
fs.writeFileSync(path.join(dir, "themes", "tarifs.md"), "---\ntitre: Tarifs\n---\nLes tarifs sont indiqués ici.\n");

const fake = await startFakeOpenAI();
Object.assign(process.env, {
  CORPUS_DIR: dir, PROVIDER: "openai-compatible", MODEL: "faux-modele", LLM_BASE_URL: fake.url, LLM_API_KEY: "cle-de-test",
  LLM_IDLE_TIMEOUT_MS: "400", PRICE_INPUT_PER_M: "1", PRICE_OUTPUT_PER_M: "2", LLM_REASONING_EFFORT: "low",
});
const { chat, PROVIDER } = await import("../src/chat.js");
const { createThinkFilter } = await import("../src/providers/openai.js");
const { publicStats } = await import("../src/limits.js");
assert.equal(PROVIDER, "openai-compatible");

// Rejoue le chat et résume les événements : texte visible final (après le dernier reset), types, usage.
const run = async (scenario, extra = [], opts = {}) => {
  const evs = [];
  for await (const ev of chat([...extra, { role: "user", content: `SCENARIO:${scenario}` }], undefined, opts)) evs.push(ev);
  let text = "";
  for (const e of evs) { if (e.type === "reset") text = ""; if (e.type === "delta" || e.type === "refused") text += e.text; }
  return { evs, text, types: evs.map((e) => e.type), error: evs.find((e) => e.type === "error")?.text };
};

try {
  // texte en streaming + paramètres envoyés (aucun paramètre Anthropic) + usage
  let r = await run("texte");
  assert.equal(r.text, "Bonjour, voici la réponse.");
  assert.deepEqual(r.types.filter((t) => t !== "delta"), ["usage", "done"]);
  assert.ok(r.evs.filter((e) => e.type === "delta").length >= 3, "le texte arrive par fragments");
  const req = fake.requests.at(-1);
  assert.equal(req.auth, "Bearer cle-de-test");
  const p = req.payload;
  assert.equal(p.model, "faux-modele"); assert.equal(p.stream, true); assert.deepEqual(p.stream_options, { include_usage: true });
  assert.equal(p.temperature, 0.2); assert.equal(p.tool_choice, "auto"); assert.equal(p.reasoning_effort, "low");
  assert.ok(p.max_tokens >= 16 && p.max_tokens <= 4000);
  assert.deepEqual(p.tools.map((t) => t.function.name), ["lire_fiche", "chercher", "presence_en_direct"]);
  assert.ok(!("output_config" in p) && !("betas" in p) && !("fallbacks" in p) && !("system" in p));
  assert.equal(p.messages[0].role, "system"); assert.ok(p.messages[0].content.includes("Index factice") && p.messages[0].content.includes("Marie-Poule"));
  assert.equal(p.messages.filter((m) => m.role === "system").length, 1);
  const u = r.evs.find((e) => e.type === "usage");
  assert.equal(u.input, 100); assert.equal(u.output, 20); assert.ok(Math.abs(u.usd - (100 * 1 + 20 * 2) / 1e6) < 1e-12, "tarifs PRICE_*");
  assert.ok(publicStats().spend_usd >= 0);

  // outil mes_presences : absent pour un anonyme (non déclaré, et refusé s'il est appelé), présent pour un membre
  assert.ok(!p.tools.some((t) => t.function.name === "mes_presences"));
  const appels = [];
  const memberTools = { mesPresences: async (mois) => { appels.push(mois); return mois === "2019-03" ? { texte: "Présences du mois 2019-03 : 2 journée(s) : 2019-03-04, 2019-03-05" } : mois === undefined ? { texte: "Historique : 2019 (total 54)" } : { erreur: "Format de mois invalide" }; } };
  r = await run("mes_presences", [], { memberTools, connected: true });
  const pm = fake.requests.at(-2).payload;
  assert.deepEqual(pm.tools.map((t) => t.function.name), ["lire_fiche", "chercher", "presence_en_direct", "mes_presences"]);
  assert.deepEqual(pm.tools.at(-1).function.parameters.required ?? [], [], "mois facultatif");
  assert.deepEqual(appels, ["2019-03"]); assert.ok(r.text.includes("2019-03-04") && !r.error, r.text);
  r = await run("mes_presences_tout", [], { memberTools, connected: true });
  assert.deepEqual(appels.at(-1), undefined); assert.equal(appels.length, 2); assert.ok(r.text.includes("2019 (total 54)"));
  r = await run("mes_presences_mauvais", [], { memberTools, connected: true });
  assert.ok(r.text.includes("Erreur : Format de mois invalide") && appels.length === 2, "mois invalide refusé avant tout appel");
  r = await run("mes_presences", [], { memberTools: { mesPresences: async () => ({ indisponible: true }) }, connected: true });
  assert.ok(r.text.includes("momentanément indisponible") && !r.error, r.text);
  r = await run("mes_presences", [], { connected: false }); // anonyme : l'outil n'existe pas, même si le modèle l'appelle
  assert.ok(r.text.includes("Outil inconnu") && appels.length === 2, r.text);
  const avant = fake.requests.length;
  r = await run("boucle", [], { memberTools, connected: true });
  assert.equal(fake.requests.length - avant, 4, "l'outil membre compte dans les 3 tours d'outils");

  // contexte du membre : même message système, en dernier
  const evs = []; for await (const ev of chat([{ role: "user", content: "SCENARIO:texte" }], undefined, { memberBlock: "# Personne connectée\nX" })) evs.push(ev);
  assert.ok(fake.requests.at(-1).payload.messages[0].content.endsWith("# Personne connectée\nX"));

  // appel d'outil (arguments fragmentés) puis réponse ; reset car le tour contenait du texte
  r = await run("outil");
  assert.deepEqual(r.types.filter((t) => t !== "delta" && t !== "usage"), ["reset", "status", "done"]);
  assert.equal(r.text, "Réponse après outil : ok");
  const second = fake.requests.at(-1).payload.messages;
  assert.equal(second.at(-2).role, "assistant"); assert.equal(second.at(-2).tool_calls[0].function.arguments, '{"mots":"tarifs"}');
  assert.equal(second.at(-1).role, "tool"); assert.equal(second.at(-1).tool_call_id, "call_1");

  // JSON d'arguments invalide : résultat d'erreur à l'outil, pas de plantage ni d'invalide renvoyé au serveur
  r = await run("json_invalide");
  assert.ok(!r.error); assert.ok(r.text.includes("Outil dit : Erreur : Arguments invalides"), r.text);
  assert.equal(fake.requests.at(-1).payload.messages.at(-2).tool_calls[0].function.arguments, "{}");

  // 3 tours d'outils maximum, tool_choice none au dernier
  const before = fake.requests.length;
  r = await run("boucle");
  assert.equal(fake.requests.length - before, 4); assert.equal(fake.requests.at(-1).payload.tool_choice, "none");
  assert.equal(r.text, "Fin forcée."); assert.equal(r.types.at(-1), "done");

  // erreurs HTTP : mêmes messages qu'avec Anthropic, sans fuite du détail
  r = await run("429"); assert.equal(r.error, "Le service est très sollicité, réessayez dans un instant."); assert.equal(r.types.at(-1), "error");
  r = await run("500"); assert.ok(r.error.startsWith("Marie-Poule a un petit souci technique") && r.error.includes("coworking-metz.fr/contact") && !r.error.includes("secret-detail"));
  r = await run("coupure"); assert.ok(r.error?.startsWith("Marie-Poule a un petit souci"));
  r = await run("silence"); assert.ok(r.error?.startsWith("Marie-Poule a un petit souci"), "délai dépassé -> erreur propre");

  // content_filter -> refus ; length -> troncature
  r = await run("filtre"); assert.deepEqual(r.types.filter((t) => t !== "usage"), ["refused", "done"]); assert.ok(r.text.includes("questions sur le Coworking Metz"));
  r = await run("longueur"); assert.ok(r.text.includes("Début") && r.text.includes("réponse tronquée"));

  // raisonnement jamais affiché
  r = await run("raisonnement"); assert.equal(r.text, "Réponse visible."); assert.ok(!r.evs.some((e) => e.type === "delta" && /réflé|think/.test(e.text)));
  r = await run("raisonnement_champ"); assert.equal(r.text, "Réponse nette.");
  r = await run("raisonnement_orphelin"); assert.equal(r.text, "Réponse."); assert.ok(r.types.includes("reset"));

  // filtre : fragments d'un caractère, texte sans balise inchangé, « < » isolé conservé
  const feed = (s, o) => { const f = createThinkFilter(o); let out = ""; for (const ch of s) out += f.push(ch); return out + f.end(); };
  assert.equal(feed("A <think>x</think>\n B"), "A B".replace(" ", " ")); // espace avant la balise conservé, saut de ligne après retiré
  assert.equal(feed("a < b et 3<4"), "a < b et 3<4");
  assert.equal(feed("<think>jamais fermé"), "");
  assert.equal(feed("pensée</think> Réponse", { startInThink: true }), "Réponse");
} finally {
  await fake.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log("providers : OK");
