// Fournisseur Anthropic : streaming, cache du préfixe, effort de raisonnement, repli serveur, refus, boucle d'outils.
import Anthropic from "@anthropic-ai/sdk";
import { REFUS_TYPE, systemPrompt } from "../prompt.js";
import { addUsage } from "../limits.js";
import { MAX_TOOL_ROUNDS, LABEL, TRUNCATED_TEXT, toolDefsFor, execTool, errorText } from "./common.js";

const FALLBACKS = process.env.FALLBACKS !== "off";

const asTools = (defs) => defs.map((t) => ({ name: t.name, description: t.description, ...(t.strict === false ? {} : { strict: true }), input_schema: t.parameters }));
const TOOLS = asTools(toolDefsFor(false)), TOOLS_MEMBER = asTools(toolDefsFor(true));

async function runTool(block, memberTools) {
  const r = await execTool(block.name, block.input ?? {}, { memberTools });
  return { type: "tool_result", tool_use_id: block.id, content: r.texte, ...(r.ok ? {} : { is_error: true }) };
}

/** Exécuteur pour un profil (src/profiles.js) : renvoie `run(history, signal, { memberBlock })`. */
export function createRunner(profile) {
  // Le SDK lit ANTHROPIC_API_KEY ; la clé du projet s'appelle CLAUDE_API_KEY.
  // Une clé non rattachée à un espace de travail exige l'en-tête anthropic-workspace-id (variable WORKSPACE_ID).
  const client = new Anthropic({
    apiKey: profile.anthropicKey || undefined,
    ...(process.env.WORKSPACE_ID ? { defaultHeaders: { "anthropic-workspace-id": process.env.WORKSPACE_ID } } : {}),
  });
  const MODEL = profile.model, MAX_TOKENS = profile.maxTokens || 700, EFFORT = profile.effort, price = profile.price;
  return async function* run(history, signal, { memberBlock, memberTools } = {}) {
    // Préfixe identique pour tous (mis en cache) ; le contexte du membre vient APRÈS, sans cache_control.
    const system = [{ type: "text", text: systemPrompt(), cache_control: { type: "ephemeral", ttl: "1h" } }];
    if (memberBlock) system.push({ type: "text", text: memberBlock });
    const messages = history.map((m) => ({ role: m.role, content: m.content }));
    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const stream = client.beta.messages.stream(
          {
            model: MODEL,
            max_tokens: MAX_TOKENS,
            system,
            messages,
            tools: memberTools ? TOOLS_MEMBER : TOOLS,
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
        const u = msg.usage ?? {};
        yield { type: "usage", ...addUsage(u, price) };

        if (msg.stop_reason === "refusal") {
          yield { type: "refused", text: REFUS_TYPE };
          yield { type: "done" };
          return;
        }
        if (msg.stop_reason === "max_tokens") {
          yield { type: "delta", text: TRUNCATED_TEXT };
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
        // Le texte de ce tour (narration avant l'outil) n'est pas la réponse : le client doit l'effacer.
        yield { type: "reset" };
        yield { type: "status", text: LABEL[uses[0].name] ?? "Consultation…" };
        messages.push({ role: "user", content: await Promise.all(uses.map((u) => runTool(u, memberTools))) });
      }
      yield { type: "done" };
    } catch (e) {
      if (signal?.aborted) return;
      const status = e instanceof Anthropic.APIError ? e.status : undefined;
      console.error("[chat] erreur API", status ?? "", e?.constructor?.name, String(e?.message ?? "").slice(0, 200));
      yield { type: "error", text: errorText(status) };
    }
  };
}
