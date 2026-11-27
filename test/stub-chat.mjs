// Remplace l'appel au modèle dans les tests (CHAT_STUB) : renvoie un texte fixe et, pour une personne connectée,
// recopie le bloc de contexte reçu afin que le test puisse vérifier ce qui serait transmis au modèle.
export const MODEL = "stub";
export async function* chat(history, signal, { memberBlock, connected, memberTools } = {}) {
  if (history.at(-1)?.content === "PROFIL?") { yield { type: "delta", text: `connected=${!!connected}` }; yield { type: "done" }; return; }
  if (/^PRESENCES\?/.test(history.at(-1)?.content ?? "")) { // outil mes_presences (réservé aux membres)
    if (!memberTools) { yield { type: "delta", text: "outil=absent" }; yield { type: "done" }; return; }
    const mois = history.at(-1).content.split(":")[1] || undefined;
    const r = await memberTools.mesPresences(mois);
    yield { type: "delta", text: `outil=${r.texte ?? JSON.stringify(r)}` }; yield { type: "done" }; return;
  }
  yield { type: "delta", text: "Texte avant outil. " };
  yield { type: "reset" };
  yield { type: "status", text: "Consultation d'une fiche…" };
  yield { type: "delta", text: memberBlock ? `Réponse personnalisée.\n${memberBlock}` : "Réponse." };
  yield { type: "done" };
}
