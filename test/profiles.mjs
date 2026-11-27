// Profils de modèle : résolution des variables, héritage, routage membre/anonyme et tarifs distincts (faux serveurs, aucun coût).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeOpenAI } from "./fake-openai.mjs";
import { resolveProfiles, profileFor, validateProfiles, publicConfig, describe } from "../src/profiles.js";

// --- résolution (sans environnement réel) ---
let P = resolveProfiles({ PROVIDER: "openai-compatible", MODEL: "m", MODEL_LABEL: "Lab", MODEL_HOSTING: "chez OVH", PRICE_INPUT_PER_M: "0.71", PRICE_OUTPUT_PER_M: "4.25", LLM_REASONING_EFFORT: "low" });
assert.equal(P.anonyme, null, "sans ANON_*, un seul profil");
assert.equal(profileFor(P, false), P.membre); assert.equal(profileFor(P, true), P.membre);
assert.deepEqual(publicConfig(P.membre), { model: "Lab", hosting: "chez OVH" });
assert.deepEqual(publicConfig(resolveProfiles({ MODEL: "m" }).membre), { model: "m", hosting: null });

P = resolveProfiles({ PROVIDER: "openai-compatible", MODEL: "gros", LLM_BASE_URL: "http://a/v1/", OVH_AI_ENDPOINTS_ACCESS_TOKEN: "K", LLM_REASONING_EFFORT: "low", MAX_OUTPUT_TOKENS: "2500",
  PRICE_INPUT_PER_M: "0.71", PRICE_OUTPUT_PER_M: "4.25", MODEL_LABEL: "Gros", MODEL_HOSTING: "chez OVH",
  ANON_MODEL: "petit", ANON_PRICE_INPUT_PER_M: "0.1", ANON_PRICE_OUTPUT_PER_M: "0.4" });
assert.equal(profileFor(P, true).model, "gros"); assert.equal(profileFor(P, false).model, "petit");
const an = P.anonyme;
assert.equal(an.provider, "openai-compatible", "fournisseur hérité"); assert.equal(an.baseUrl, "http://a/v1"); assert.equal(an.apiKey, "K", "clé OVH par défaut");
assert.equal(an.maxTokens, 2500); assert.deepEqual(an.price, { input: 0.1, output: 0.4 });
assert.equal(an.reasoningEffort, "", "l'effort de raisonnement n'est pas hérité");
assert.deepEqual(publicConfig(an), { model: "petit", hosting: null }, "ni libellé ni hébergement hérités");
assert.deepEqual(P.membre.price, { input: 0.71, output: 4.25 });
const ov = resolveProfiles({ MODEL: "gros", ANON_PROVIDER: "anthropic", ANON_MODEL: "c", ANON_LLM_API_KEY: "A", ANON_LLM_BASE_URL: "http://b/v1", ANON_LLM_REASONING_EFFORT: "high", ANON_MAX_OUTPUT_TOKENS: "700", ANON_MODEL_LABEL: "C", ANON_MODEL_HOSTING: "H" }).anonyme;
assert.deepEqual([ov.provider, ov.apiKey, ov.baseUrl, ov.reasoningEffort, ov.maxTokens, ov.label, ov.hosting], ["anthropic", "A", "http://b/v1", "high", 700, "C", "H"]);
assert.deepEqual(describe(ov), { provider: "anthropic", model: "c" });
assert.ok(!JSON.stringify(describe(ov)).includes("A\""), "describe n'expose pas de clé");

// --- validation ---
assert.equal(validateProfiles(resolveProfiles({ MODEL: "m" })), null);
assert.match(validateProfiles(resolveProfiles({})), /^MODEL manquant/);
assert.match(validateProfiles(resolveProfiles({ MODEL: "m", PROVIDER: "x" })), /PROVIDER inconnu/);
assert.match(validateProfiles(resolveProfiles({ MODEL: "m", ANON_PROVIDER: "x" })), /^ANON_PROVIDER inconnu/);

// --- routage : deux faux serveurs, deux modèles, deux tarifs, plafond de dépense commun ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mp-corpus-"));
fs.writeFileSync(path.join(dir, "INDEX.md"), "# Index factice\n");
const gros = await startFakeOpenAI(), petit = await startFakeOpenAI();
Object.assign(process.env, { CORPUS_DIR: dir, PROVIDER: "openai-compatible", MODEL: "modele-membre", LLM_BASE_URL: gros.url, LLM_API_KEY: "cle-membre",
  PRICE_INPUT_PER_M: "1", PRICE_OUTPUT_PER_M: "2", LLM_REASONING_EFFORT: "low", MAX_OUTPUT_TOKENS: "2000",
  ANON_MODEL: "modele-anonyme", ANON_LLM_BASE_URL: petit.url, ANON_LLM_API_KEY: "cle-anonyme", ANON_PRICE_INPUT_PER_M: "0.1", ANON_PRICE_OUTPUT_PER_M: "0.2", DAILY_BUDGET_USD: "0.0003" });
try {
  const { chat } = await import("../src/chat.js");
  const { budgetExceeded, publicStats } = await import("../src/limits.js");
  const go = async (connected) => { const evs = []; for await (const e of chat([{ role: "user", content: "SCENARIO:texte" }], undefined, { connected })) evs.push(e); return evs; };

  let evs = await go(false);
  let req = petit.requests.at(-1);
  assert.equal(req.payload.model, "modele-anonyme"); assert.equal(req.auth, "Bearer cle-anonyme"); assert.ok(!("reasoning_effort" in req.payload), "pas d'effort hérité");
  assert.equal(gros.requests.length, 0, "l'anonyme n'appelle pas le modèle des membres");
  let u = evs.find((e) => e.type === "usage");
  assert.ok(Math.abs(u.usd - (100 * 0.1 + 20 * 0.2) / 1e6) < 1e-12, "tarifs ANON_PRICE_*");
  assert.equal(budgetExceeded(), false);

  evs = await go(true);
  req = gros.requests.at(-1);
  assert.equal(req.payload.model, "modele-membre"); assert.equal(req.auth, "Bearer cle-membre"); assert.equal(req.payload.reasoning_effort, "low"); assert.equal(req.payload.max_tokens, 2000);
  assert.equal(petit.requests.length, 1);
  u = evs.find((e) => e.type === "usage");
  assert.ok(Math.abs(u.usd - (100 * 1 + 20 * 2) / 1e6) < 1e-12, "tarifs PRICE_*");

  // dépense cumulée des deux profils : 0,000014 + 0,00014 ; le plafond de 0,0003 est franchi après deux appels membre de plus
  await go(true); await go(true);
  assert.ok(publicStats().spend_usd >= 0.0003 || budgetExceeded(), "le plafond compte la dépense des deux profils");
  assert.equal(budgetExceeded(), true);
} finally {
  await gros.close(); await petit.close(); fs.rmSync(dir, { recursive: true, force: true });
}
console.log("profils : OK");
process.exit(0);
