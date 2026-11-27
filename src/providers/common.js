// Éléments communs aux fournisseurs de modèle : outils, exécution, messages utilisateur.
import { chercher, lireFiche } from "../corpus.js";
import { CONTACT_URL } from "../prompt.js";

export const MAX_TOOL_ROUNDS = 3;
export const LABEL = { lire_fiche: "Consultation d'une fiche…", chercher: "Recherche dans le corpus…" };
export const TRUNCATED_TEXT = "\n\n*(réponse tronquée : posez-moi la question de façon plus précise pour la suite.)*";
export const BUSY_TEXT = "Le service est très sollicité, réessayez dans un instant.";
export const FAILURE_TEXT = `Marie-Poule a un petit souci technique. Réessayez dans un instant, ou passez par la page Contact : ${CONTACT_URL}`;

/** Message d'erreur affiché à l'utilisateur selon le statut HTTP (429/529 : service sollicité). */
export const errorText = (status) => (status === 429 || status === 529 ? BUSY_TEXT : FAILURE_TEXT);

// Définition neutre des outils (JSON Schema) ; chaque fournisseur l'habille à sa façon.
export const TOOL_DEFS = [
  {
    name: "lire_fiche",
    description:
      "Charge le texte complet d'une fiche du corpus. À utiliser dès qu'une question demande un détail, un historique ou un chiffre précis. Le chemin est celui du catalogue, relatif à context/ (ex. themes/tarifs-et-abonnements.md).",
    parameters: {
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
    parameters: {
      type: "object",
      properties: { mots: { type: "string", description: "Quelques mots-clés en français." } },
      required: ["mots"],
      additionalProperties: false,
    },
  },
];

/** Exécute un outil : { ok, texte }. `input` doit déjà être un objet. */
export function execTool(name, input) {
  try {
    if (name === "lire_fiche") return lireFiche(input?.chemin);
    if (name === "chercher") return chercher(input?.mots);
    return { ok: false, texte: "Outil inconnu." };
  } catch {
    return { ok: false, texte: "Erreur interne de l'outil." };
  }
}
