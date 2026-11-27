// Remplace l'appel au modèle dans les tests (CHAT_STUB) : renvoie un texte fixe et, pour une personne connectée,
// recopie le bloc de contexte reçu afin que le test puisse vérifier ce qui serait transmis au modèle.
export const MODEL = "stub";
export async function* chat(history, signal, { memberBlock } = {}) {
  yield { type: "delta", text: "Texte avant outil. " };
  yield { type: "reset" };
  yield { type: "status", text: "Consultation d'une fiche…" };
  yield { type: "delta", text: memberBlock ? `Réponse personnalisée.\n${memberBlock}` : "Réponse." };
  yield { type: "done" };
}
