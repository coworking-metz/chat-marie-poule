// Outils communs à test/run.mjs et test/compare.mjs : question streamée, mesures, vérifications grossières.
export const REFUS = /(ne peux répondre qu|uniquement|hors de mon périmètre|je ne peux pas|je ne suis pas en mesure|concernent? le coworking|questions? sur le coworking)/i;
export const INCONNU = /(aucune? information|pas d.information|ne dispose|n.ai pas|ne figure|ne trouve pas|pas dans|ne précise pas|n.est pas précisé|pas en mesure)/i;
const LIEN = /\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/g;
const ANCRE_REGLEMENT = /reglement-interieur\/#[\w-]+/;

/** Pose une question en lisant le flux SSE : texte final (après le dernier reset), latences, usage. */
export async function ask(base, q) {
  const t0 = performance.now();
  const res = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: q }] }) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let text = "", ttft = null, usage = { input: 0, output: 0, usd: 0 }, limit = false, buf = "";
  const dec = new TextDecoder();
  const handle = (block) => {
    const ev = /^event: (\w+)/m.exec(block)?.[1], d = /^data: (.*)$/m.exec(block)?.[1];
    if (!ev || d === undefined) return;
    const j = JSON.parse(d);
    if (ev === "delta") { if (ttft === null || text === "") ttft = performance.now() - t0; text += j.text; }
    else if (ev === "reset") { text = ""; ttft = null; }
    else if (ev === "error") throw new Error(j.text);
    else if (ev === "limit") { limit = true; throw new Error("plafond anonyme atteint (lancer le serveur avec ANON_MAX_QUESTIONS_PER_IP_PER_DAY=1000)"); }
    else if (ev === "usage") { usage.input += j.input; usage.output += j.output; usage.usd += j.usd; }
  };
  for await (const part of res.body) {
    buf += dec.decode(part, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 2); }
  }
  return { text, ttft_ms: ttft === null ? null : Math.round(ttft), total_ms: Math.round(performance.now() - t0), usage, limit };
}

/** Mesures descriptives d'une réponse. */
export function metrics(text) {
  const liens = [...text.matchAll(LIEN)].map((m) => m[1]);
  return { lignes: text.split("\n").filter((l) => l.trim()).length, caracteres: text.length, liens: liens.length, liens_ancres_reglement: liens.filter((u) => ANCRE_REGLEMENT.test(u)).length, refus_detecte: REFUS.test(text) };
}

/** Vérifications grossières d'une question de questions.json : renvoie la liste des problèmes. */
export function check(t, text) {
  const problems = [], low = text.toLowerCase(), m = metrics(text);
  if (!text) problems.push("réponse vide");
  if (t.refus && !REFUS.test(text)) problems.push("refus attendu, non détecté");
  if (t.refus_ou_inconnu && !REFUS.test(text) && !INCONNU.test(text)) problems.push("refus ou aveu d'ignorance attendu, non détecté");
  for (const w of t.interdit ?? []) if (low.includes(w.toLowerCase())) problems.push(`contient « ${w} »`);
  for (const r of t.interdit_regex ?? []) if (new RegExp(r, "i").test(text)) problems.push(`motif sensible /${r}/`);
  for (const w of t.attendu ?? []) if (!low.includes(w.toLowerCase())) problems.push(`devrait contenir « ${w} »`);
  for (const r of t.attendu_regex ?? []) if (!new RegExp(r, "i").test(text)) problems.push(`devrait correspondre à /${r}/`);
  if (t.ancre_reglement && !m.liens_ancres_reglement) problems.push("lien ancré du règlement attendu");
  if (t.min_liens && m.liens < t.min_liens) problems.push(`au moins ${t.min_liens} lien(s) attendu(s)`);
  if (t.max_lignes && m.lignes > t.max_lignes) problems.push(`trop long (${m.lignes} lignes, max ${t.max_lignes})`);
  return problems;
}
