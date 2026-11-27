// Faux serveur HTTP compatible OpenAI (POST /v1/chat/completions, streaming SSE) pour les tests hors ligne.
// Le scénario est choisi par le dernier message « user » ; un 2e appel (après un message « tool ») reçoit la suite du scénario.
import http from "node:http";

const sse = (res, objs) => { res.writeHead(200, { "Content-Type": "text/event-stream" }); for (const o of objs) res.write(`data: ${JSON.stringify(o)}\n\n`); res.write("data: [DONE]\n\n"); res.end(); };
const chunk = (delta, finish = null) => ({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] });
const usage = (p = 100, c = 20) => ({ id: "x", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c } });
const text = (...parts) => [chunk({ role: "assistant", content: "" }), ...parts.map((t) => chunk({ content: t })), chunk({}, "stop"), usage()];
const toolCall = (id, name, argParts, pre = []) => [
  chunk({ role: "assistant", content: "" }), ...pre.map((t) => chunk({ content: t })),
  chunk({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] }),
  ...argParts.map((a) => chunk({ tool_calls: [{ index: 0, function: { arguments: a } }] })),
  chunk({}, "tool_calls"), usage(200, 30),
];

export async function startFakeOpenAI() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    if (req.url !== "/v1/chat/completions" || req.method !== "POST") { res.writeHead(404); return res.end("{}"); }
    const payload = JSON.parse(body);
    requests.push({ payload, auth: req.headers.authorization });
    const msgs = payload.messages;
    const last = [...msgs].reverse().find((m) => m.role === "user")?.content ?? "";
    const afterTool = msgs.at(-1).role === "tool";
    const scen = /SCENARIO:(\w+)/.exec(last)?.[1];
    switch (scen) {
      case "texte": return sse(res, text("\n  ", "Bonjour, ", "voici la ", "réponse."));
      case "outil":
        if (!afterTool) return sse(res, toolCall("call_1", "chercher", ['{"mo', 'ts":"tar', 'ifs"}'], ["Je vais chercher… "]));
        return sse(res, text("Réponse après outil : ", msgs.at(-1).content.length > 0 ? "ok" : "vide"));
      case "json_invalide":
        if (!afterTool) return sse(res, toolCall("call_2", "lire_fiche", ['{"chemin": ']));
        return sse(res, text(`Outil dit : ${msgs.at(-1).content.slice(0, 40)}`));
      case "boucle": // demande toujours un outil : doit s'arrêter après 3 tours, dernier tour en tool_choice none
        if (payload.tool_choice === "none") return sse(res, text("Fin forcée."));
        return sse(res, toolCall("call_b", "chercher", ['{"mots":"x"}']));
      case "429": res.writeHead(429, { "Content-Type": "application/json" }); return res.end('{"error":{"message":"rate limit"}}');
      case "500": res.writeHead(500, { "Content-Type": "application/json" }); return res.end('{"error":{"message":"boom secret-detail"}}');
      case "filtre": return sse(res, [chunk({ role: "assistant", content: "" }), chunk({}, "content_filter"), usage()]);
      case "longueur": return sse(res, [chunk({ role: "assistant", content: "Début " }), chunk({}, "length"), usage()]);
      case "raisonnement": return sse(res, text("<th", "ink>je réflé", "chis…</thi", "nk>\n\nRéponse ", "visible."));
      case "raisonnement_champ": return sse(res, [chunk({ role: "assistant", reasoning_content: "secret" }), chunk({ reasoning_content: "encore" }), chunk({ content: "Réponse nette." }), chunk({}, "stop"), usage()]);
      case "raisonnement_orphelin": return sse(res, text("pensée cachée</think>Réponse."));
      case "coupure": res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(`data: ${JSON.stringify(chunk({ content: "Début" }))}\n\n`); res.write(`data: ${JSON.stringify({ error: { message: "interrompu", code: 500 } })}\n\n`); return res.end();
      case "silence": return; // ne répond jamais (test du délai)
      default: return sse(res, text("Réponse par défaut."));
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => { server.closeAllConnections?.(); return new Promise((r) => server.close(r)); } };
}
