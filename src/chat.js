// Appel à l'API Anthropic : streaming, boucle d'outils (lire_fiche / chercher), gestion des refus.
import Anthropic from "@anthropic-ai/sdk";
import { chercher, lireFiche } from "./corpus.js";
import { CONTACT_URL, REFUS_TYPE, systemPrompt } from "./prompt.js";
import { addUsage } from "./limits.js";

export const MODEL = process.env.MODEL || "claude-opus-5-5";
const MAX_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS) || 1500;
const MAX_TOOL_ROUNDS = 3;
const EFFORT = process.env.EFFORT || "low";
const FALLBACKS = process.env.FALLBACKS !== "off";

// Le SDK lit ANTHROPIC_API_KEY ; la clé du projet s'appelle CLAUDE_API_KEY.
// Une clé non rattachée à un espace de travail exige l'en-tête anthropic-workspace-id (variable WORKSPACE_ID).
const client = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY,
  ...(process.env.WORKSPACE_ID ? { defaultHeaders: { "anthropic-workspace-id": process.env.WORKSPACE_ID } } : {}),
});

const TOOLS = [
  {
    name: "lire_fiche",
    description:
      "Charge le texte complet d'une fiche du corpus. À utiliser dès qu'une question demande un détail, un historique ou un chiffre précis. Le chemin est celui du catalogue, relatif à context/ (ex. themes/tarifs-et-abonnements.md).",
    strict: true,
    input_schema: {
      type: "object",
      properties: { chemin: { type: "string", description: "Chemin exact de la fiche dans le catalogue." } },
      required: ["chemin"],
      additionalProperties: false,
    },
  },
  {
    name: "chercher",
    description:
      "Recherche des mots-clés dans toutes les fiches et renvoie les fiches les plus pertinentes avec des extraits. À utiliser quand le catalogue ne permet pas de savoir quelle fiche charger.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { mots: { type: "string", description: "Quelques mots-clés en français." } },
      required: ["mots"],
      additionalProperties: false,
    },
  },
];

function runTool(block) {
  try {
    const input = block.input ?? {};
    const r = block.name === "lire_fiche" ? lireFiche(input.chemin) : block.name === "chercher" ? chercher(input.mots) : { ok: false, texte: "Outil inconnu." };
    return { type: "tool_result", tool_use_id: block.id, content: r.texte, ...(r.ok ? {} : { is_error: true }) };
  } catch (e) {
    return { type: "tool_result", tool_use_id: block.id, content: "Erreur interne de l'outil.", is_error: true };
  }
}

const LABEL = { lire_fiche: "Consultation d'une fiche…", chercher: "Recherche dans le corpus…" };

/**
 * Générateur d'événements : { type: "status"|"delta"|"done"|"error", ... }.
 * `history` = messages {role, content:string} déjà validés.
 */
export async function* chat(history, signal) {
  const system = [{ type: "text", text: systemPrompt(), cache_control: { type: "ephemeral", ttl: "1h" } }];
  const messages = history.map((m) => ({ role: m.role, content: m.content }));
  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const stream = client.beta.messages.stream(
        {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system,
          messages,
          tools: TOOLS,
          tool_choice: { type: round < MAX_TOOL_ROUNDS ? "auto" : "none" },
          output_config: { effort: EFFORT },
          ...(FALLBACKS ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
        },
        { signal },
      );
      for await (const ev of stream) {
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") yield { type: "delta", text: ev.delta.text };
      }
      const msg = await stream.finalMessage();
      addUsage(msg.usage ?? {});

      if (msg.stop_reason === "refusal") {
        yield { type: "refused", text: REFUS_TYPE };
        yield { type: "done" };
        return;
      }
      if (msg.stop_reason === "max_tokens") {
        yield { type: "delta", text: "\n\n*(réponse tronquée : posez-moi la question de façon plus précise pour la suite.)*" };
        yield { type: "done" };
        return;
      }
      if (msg.stop_reason !== "tool_use") {
        yield { type: "done" };
        return;
      }
      // Le tour de l'assistant est renvoyé tel quel (blocs de réflexion compris), puis les résultats d'outils.
      messages.push({ role: "assistant", content: msg.content });
      const uses = msg.content.filter((b) => b.type === "tool_use");
      yield { type: "status", text: LABEL[uses[0].name] ?? "Consultation…" };
      messages.push({ role: "user", content: uses.map(runTool) });
    }
    yield { type: "done" };
  } catch (e) {
    if (signal?.aborted) return;
    const status = e instanceof Anthropic.APIError ? e.status : undefined;
    console.error("[chat] erreur API", status ?? "", e?.constructor?.name, String(e?.message ?? "").slice(0, 200));
    const text =
      status === 429 || status === 529
        ? "Le service est très sollicité, réessayez dans un instant."
        : `Marie-Poule a un petit souci technique. Réessayez dans un instant, ou passez par la page Contact : ${CONTACT_URL}`;
    yield { type: "error", text };
  }
}
