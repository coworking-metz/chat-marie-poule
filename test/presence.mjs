// Tests hors ligne de l'outil presence_en_direct : faux serveur de présence, validation, cache, délai, contrat.
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeOpenAI } from "./fake-openai.mjs";

let mode = "normal", hits = 0;
const srv = http.createServer((req, res) => {
  hits++;
  const json = (o, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(typeof o === "string" ? o : JSON.stringify(o)); };
  const base = { presents: 14, capacite: 40, libres: 26, estimation: true, delai_minutes: 10, mis_a_jour: "2026-11-27T12:03:23+01:00", indisponible: false, extra: "ignoré" };
  switch (mode) {
    case "normal": return json(base);
    case "indispo": return json({ ...base, presents: null, libres: null, indisponible: true });
    case "aberrant": return json({ ...base, presents: 5000 });
    case "negatif": return json({ ...base, presents: -1 });
    case "chaine": return json({ ...base, presents: "14" });
    case "invalide": return json("{pas du json");
    case "http500": return json({}, 500);
    case "lent": return; // ne répond jamais
  }
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
process.env.PRESENCE_URL = `http://127.0.0.1:${srv.address().port}/presence-now`;

const { presenceEnDirect, resetPresenceCache, validerPresence, PRESENCE_URL_DEFAUT } = await import("../src/presence.js");
const { execTool, TOOL_DEFS, MAX_TOOL_ROUNDS } = await import("../src/providers/common.js");
const get = async (m) => { mode = m; resetPresenceCache(); hits = 0; return presenceEnDirect(); };
const INDISPO = { indisponible: true };

try {
  assert.equal(PRESENCE_URL_DEFAUT, "https://www.coworking-metz.fr/api-json-wp/cowo/v1/presence-now");

  // réponse normale : seuls les champs attendus, jamais le champ inconnu
  let r = await get("normal");
  assert.deepEqual(r, { presents: 14, capacite: 40, libres: 26, estimation: true, mis_a_jour: "2026-11-27T12:03:23+01:00" });

  // cache de 45 s partagé : un deuxième appel ne sollicite pas le serveur
  await presenceEnDirect(); await presenceEnDirect();
  assert.equal(hits, 1, "cache mémoire");

  // cas dégradés -> indisponible
  for (const m of ["indispo", "aberrant", "negatif", "chaine", "invalide", "http500"]) assert.deepEqual(await get(m), INDISPO, m);
  // un échec n'est mémorisé que brièvement, mais bien mémorisé (pas de marteau)
  hits = 0; await presenceEnDirect(); assert.equal(hits, 0);

  // délai de 3 s, sans relance
  const t0 = Date.now(); r = await get("lent");
  assert.deepEqual(r, INDISPO); assert.ok(Date.now() - t0 < 4500 && hits === 1, "timeout 3 s, une seule tentative");

  // contrat : validerPresence lit presents, capacite, mis_a_jour ; recalcule libres ; refuse indisponible
  assert.deepEqual(validerPresence({ presents: 3, capacite: 40, libres: 999, mis_a_jour: "2026-11-27T10:00:00+01:00" }), { presents: 3, capacite: 40, libres: 37, estimation: true, mis_a_jour: "2026-11-27T10:00:00+01:00" });
  assert.equal(validerPresence({ presents: 3 }), null); assert.equal(validerPresence(null), null);
  assert.equal(validerPresence({ presents: 3, capacite: 40, indisponible: true }), null);
  assert.equal(validerPresence({ presents: 200, capacite: 40 }).libres, 0);
  assert.equal(validerPresence({ presents: 201, capacite: 40 }), null);

  // outil : déclaration (schéma d'entrée vide) et exécution
  const def = TOOL_DEFS.find((t) => t.name === "presence_en_direct");
  assert.deepEqual(def.parameters, { type: "object", properties: {}, additionalProperties: false });
  mode = "normal"; resetPresenceCache();
  const out = await execTool("presence_en_direct", {});
  assert.equal(out.ok, true); assert.equal(JSON.parse(out.texte).presents, 14);
  assert.ok(!/[«»]|nom|mac/i.test(Object.keys(JSON.parse(out.texte)).join()), "aucune donnée nominative");

  // faux modèle qui appelle l'outil (fournisseur OpenAI-compatible), compté dans la limite de tours
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mp-corpus-"));
  fs.writeFileSync(path.join(dir, "INDEX.md"), "# Index factice\n## Catalogue des fiches\n");
  const fake = await startFakeOpenAI();
  Object.assign(process.env, { CORPUS_DIR: dir, PROVIDER: "openai-compatible", MODEL: "faux", LLM_BASE_URL: fake.url, LLM_API_KEY: "x", LLM_IDLE_TIMEOUT_MS: "2000" });
  try {
    const { chat } = await import("../src/chat.js");
    resetPresenceCache(); mode = "normal"; hits = 0;
    const evs = []; for await (const ev of chat([{ role: "user", content: "SCENARIO:presence" }], undefined, {})) evs.push(ev);
    const text = evs.filter((e) => e.type === "delta").map((e) => e.text).join("");
    assert.ok(text.includes('"presents":14') && text.includes('"estimation":true'), text);
    assert.equal(hits, 1);
    assert.ok(evs.some((e) => e.type === "status" && /présence/i.test(e.text)));
    assert.ok(fake.requests[0].payload.tools.some((t) => t.function.name === "presence_en_direct"));
    assert.equal(MAX_TOOL_ROUNDS, 3);
  } finally { await fake.close(); }
  console.log("presence : OK");
} finally { srv.closeAllConnections?.(); srv.close(); }
