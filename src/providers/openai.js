// Fournisseur OpenAI-compatible (OVHcloud AI Endpoints, vLLM, Ollama, etc.) : appel direct à
// POST <LLM_BASE_URL>/chat/completions avec fetch (pas de dépendance), streaming SSE, function calling.
import { REFUS_TYPE, systemPrompt } from "../prompt.js";
import { addUsage } from "../limits.js";
import { MAX_TOOL_ROUNDS, LABEL, TRUNCATED_TEXT, TOOL_DEFS, execTool, errorText } from "./common.js";

const MODEL = process.env.MODEL;
const BASE_URL = (process.env.LLM_BASE_URL || "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1").replace(/\/+$/, "");
const API_KEY = process.env.LLM_API_KEY || process.env.OVH_AI_ENDPOINTS_ACCESS_TOKEN || "";
const MAX_TOKENS = Math.min(Math.max(Number(process.env.MAX_OUTPUT_TOKENS) || 1000, 16), 4000);
const TEMPERATURE = process.env.LLM_TEMPERATURE !== undefined && process.env.LLM_TEMPERATURE !== "" ? Number(process.env.LLM_TEMPERATURE) : 0.2;
const REASONING_EFFORT = process.env.LLM_REASONING_EFFORT || ""; // facultatif (low|medium|high) : gpt-oss, etc.
const IDLE_TIMEOUT_MS = Number(process.env.LLM_IDLE_TIMEOUT_MS) || 45_000; // sans aucun octet reçu
const THINK_PREFIXED = process.env.LLM_THINK_PREFIXED === "1"; // le modèle n'émet que « </think> » (balise ouvrante dans son gabarit)

if (!API_KEY && BASE_URL.includes("ovh.net")) console.error("[chat] LLM_API_KEY / OVH_AI_ENDPOINTS_ACCESS_TOKEN absent : les appels à OVH échoueront.");

const TOOLS = TOOL_DEFS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));

class HttpError extends Error {
  constructor(status, detail) {
    super(`HTTP ${status} ${detail}`);
    this.status = status;
  }
}

/**
 * Filtre de streaming du « raisonnement » intégré au texte (<think>…</think>) : ne laisse passer que la réponse.
 * Gère les balises coupées entre deux fragments. `push` renvoie le texte visible, `end` vide le tampon ;
 * `stray` passe à true si un « </think> » est apparu sans balise ouvrante (le texte déjà émis était du raisonnement).
 */
export function createThinkFilter({ startInThink = false } = {}) {
  const OPEN = "<think>", CLOSE = "</think>";
  let inThink = startInThink, buf = "", skipWs = false;
  const f = {
    stray: false,
    push(chunk) {
      buf += chunk;
      let out = "";
      for (;;) {
        const tag = inThink ? CLOSE : OPEN;
        const i = buf.indexOf(tag);
        if (i >= 0) {
          if (!inThink) out += buf.slice(0, i);
          buf = buf.slice(i + tag.length);
          inThink = !inThink;
          skipWs = !inThink; // retire les sauts de ligne qui suivent </think>
          continue;
        }
        if (!inThink) {
          const j = buf.indexOf(CLOSE);
          if (j >= 0) { // </think> orphelin
            out = ""; // tout ce qui précède était du raisonnement
            buf = buf.slice(j + CLOSE.length);
            f.stray = true;
            skipWs = true;
            continue;
          }
        }
        // Conserve en tampon la fin qui pourrait être le début d'une balise.
        let keep = 0;
        for (const t of inThink ? [CLOSE] : [OPEN, CLOSE]) for (let k = Math.min(t.length - 1, buf.length); k > keep; k--) if (buf.endsWith(t.slice(0, k))) { keep = k; break; }
        const emit = buf.slice(0, buf.length - keep);
        buf = buf.slice(buf.length - keep);
        if (!inThink) out += emit;
        break;
      }
      if (skipWs && out) { out = out.replace(/^\s+/, ""); if (out) skipWs = false; }
      return out;
    },
    end() {
      const rest = inThink ? "" : buf;
      buf = "";
      return skipWs ? rest.replace(/^\s+/, "") : rest;
    },
  };
  return f;
}

/** Lit un flux SSE et renvoie les objets JSON de chaque ligne « data: » (hors [DONE]). */
async function* sseJson(body, bump) {
  const dec = new TextDecoder();
  let buf = "";
  for await (const part of body) {
    bump();
    buf += dec.decode(part, { stream: true });
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
      const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (!data || data === "[DONE]") continue;
      let obj;
      try { obj = JSON.parse(data); } catch { continue; }
      if (obj?.error) throw new HttpError(Number(obj.error.code) || 500, String(obj.error.message ?? "").slice(0, 150));
      yield obj;
    }
  }
}

/** Un tour de modèle : renvoie { text, toolCalls, finish, usage } en émettant les fragments de texte visibles via `emit`. */
async function* turn(messages, round, signal) {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let timer;
  const bump = () => { clearTimeout(timer); timer = setTimeout(() => ctl.abort(new Error("délai dépassé")), IDLE_TIMEOUT_MS); };
  bump();
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}) },
      body: JSON.stringify({
        model: MODEL,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
        tools: TOOLS,
        tool_choice: round < MAX_TOOL_ROUNDS ? "auto" : "none",
        ...(REASONING_EFFORT ? { reasoning_effort: REASONING_EFFORT } : {}),
      }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new HttpError(res.status, (await res.text().catch(() => "")).slice(0, 150));
    bump();

    const filter = createThinkFilter({ startInThink: THINK_PREFIXED });
    const calls = []; // fragments d'appels d'outils accumulés par index
    let text = "", finish = null, usage = null;
    for await (const chunk of sseJson(res.body, bump)) {
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const d = choice.delta ?? {};
      // d.reasoning_content / d.reasoning : raisonnement du modèle, volontairement ignoré (jamais affiché).
      if (typeof d.content === "string" && d.content) {
        const was = filter.stray;
        const vis = filter.push(d.content);
        if (filter.stray && !was) yield { type: "reset" }; // le texte déjà émis était du raisonnement
        if (filter.stray && !was) text = "";
        if (vis) { text += vis; yield { type: "delta", text: vis }; }
      }
      for (const tc of d.tool_calls ?? []) {
        const idx = tc.index ?? (tc.id ? calls.length : Math.max(calls.length - 1, 0));
        const c = (calls[idx] ??= { id: "", name: "", args: "" });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.args += tc.function.arguments;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    const tail = filter.end();
    if (tail) { text += tail; yield { type: "delta", text: tail }; }
    return { text, toolCalls: calls.filter(Boolean), finish, usage };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Valide les arguments d'un appel d'outil : renvoie { input } ou { erreur }. */
function parseArgs(raw) {
  if (!raw || !raw.trim()) return { input: {} };
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return { input: v };
  } catch { /* invalide */ }
  return { erreur: "Arguments invalides : un objet JSON est attendu (ex. {\"chemin\": \"themes/tarifs-et-abonnements.md\"}). Réessayez avec des arguments valides." };
}

export async function* run(history, signal, { memberBlock } = {}) {
  // Un seul message système (certains gabarits de modèles refusent plusieurs messages « system ») ;
  // le contexte du membre vient en dernier pour que le préfixe reste identique pour tous.
  const system = systemPrompt() + (memberBlock ? `\n\n${memberBlock}` : "");
  const messages = [{ role: "system", content: system }, ...history.map((m) => ({ role: m.role, content: m.content }))];
  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const it = turn(messages, round, signal);
      let r;
      for (;;) {
        const n = await it.next();
        if (n.done) { r = n.value; break; }
        yield n.value;
      }
      if (r.usage) {
        const p = r.usage.prompt_tokens ?? 0, c = r.usage.completion_tokens ?? 0;
        yield { type: "usage", ...addUsage({ input_tokens: p, output_tokens: c }) };
      }

      if (r.finish === "content_filter") {
        yield { type: "refused", text: REFUS_TYPE };
        yield { type: "done" };
        return;
      }
      if (r.finish === "length") {
        yield { type: "delta", text: TRUNCATED_TEXT };
        yield { type: "done" };
        return;
      }
      if (!r.toolCalls.length || round >= MAX_TOOL_ROUNDS) {
        yield { type: "done" };
        return;
      }
      const calls = r.toolCalls.map((c, i) => ({ ...c, id: c.id || `call_${round}_${i}`, parsed: parseArgs(c.args) }));
      messages.push({
        role: "assistant",
        content: r.text || null,
        tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.parsed.input ? JSON.stringify(c.parsed.input) : "{}" } })),
      });
      // Le texte de ce tour (narration avant l'outil) n'est pas la réponse : le client doit l'effacer.
      if (r.text) yield { type: "reset" };
      yield { type: "status", text: LABEL[calls[0].name] ?? "Consultation…" };
      for (const c of calls) {
        const out = c.parsed.erreur ? { ok: false, texte: c.parsed.erreur } : execTool(c.name, c.parsed.input);
        messages.push({ role: "tool", tool_call_id: c.id, name: c.name, content: out.ok ? out.texte : `Erreur : ${out.texte}` });
      }
    }
    yield { type: "done" };
  } catch (e) {
    if (signal?.aborted) return;
    const status = e instanceof HttpError ? e.status : undefined;
    console.error("[chat] erreur API", status ?? "", e?.constructor?.name, String(e?.message ?? "").slice(0, 200));
    yield { type: "error", text: errorText(status) };
  }
}
