// Point d'entrée du chat : choisit le fournisseur de modèle (PROVIDER) et lui délègue.
//   PROVIDER=anthropic          (défaut) API Anthropic -> src/providers/anthropic.js
//   PROVIDER=openai-compatible  OVH AI Endpoints ou tout serveur compatible OpenAI -> src/providers/openai.js
// Générateur d'événements : { type: "delta"|"reset"|"status"|"refused"|"usage"|"error"|"done", ... }.
export const PROVIDER = process.env.PROVIDER || "anthropic";
export const MODEL = process.env.MODEL;
if (!["anthropic", "openai-compatible"].includes(PROVIDER)) {
  console.error(`PROVIDER inconnu : « ${PROVIDER} » (attendu : anthropic ou openai-compatible).`);
  process.exit(1);
}
if (!MODEL) {
  console.error("MODEL manquant : ajoutez MODEL=claude-sonnet-5-5 (ou l'identifiant du modèle du fournisseur) dans .env.");
  process.exit(1);
}

const provider = await import(PROVIDER === "anthropic" ? "./providers/anthropic.js" : "./providers/openai.js");

/** `history` = messages {role, content:string} déjà validés. */
export async function* chat(history, signal, opts = {}) {
  yield* provider.run(history, signal, opts);
}
