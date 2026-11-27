// Éléments communs aux fournisseurs de modèle : outils, exécution, messages utilisateur.
import { chercher, lireFiche } from "../corpus.js";
import { CONTACT_URL } from "../prompt.js";
import { presenceEnDirect } from "../presence.js";

export const MAX_TOOL_ROUNDS = 3;
export const LABEL = { lire_fiche: "Consultation d'une fiche…", chercher: "Recherche dans le corpus…", presence_en_direct: "Consultation de la présence en direct…", mes_presences: "Consultation de vos présences…" };
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
  {
    name: "presence_en_direct",
    description:
      "Donne le nombre estimé de personnes présentes dans l'espace en ce moment, la capacité et les postes libres. Sans argument. À utiliser pour toute question sur l'affluence actuelle ou sur la place disponible maintenant.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
];

// Outil réservé aux personnes connectées (déclaré et exécutable seulement si `memberTools` est fourni par le serveur).
// `mois` est facultatif : le schéma n'impose donc pas le mode strict (Anthropic).
export const MEMBER_TOOL_DEFS = [
  {
    name: "mes_presences",
    description:
      "Historique des venues PASSÉES de la personne connectée (jamais d'une autre personne). Sans argument : journées par mois et par année sur tout son historique, première venue et total. Avec mois (AAAA-MM) : les jours exacts de ce mois. À utiliser pour toute question sur un mois, une année, un meilleur mois, une comparaison ou des jours précis du passé.",
    parameters: {
      type: "object",
      properties: { mois: { type: "string", description: "Facultatif. Mois au format AAAA-MM (ex. 2019-03) pour obtenir les jours exacts de ce mois." } },
      additionalProperties: false,
    },
    strict: false,
  },
];

/** Outils déclarés au modèle : ceux du corpus, plus ceux des membres si le serveur les fournit (`memberTools`). */
export const toolDefsFor = (memberTools) => (memberTools ? [...TOOL_DEFS, ...MEMBER_TOOL_DEFS] : TOOL_DEFS);

/** Exécute un outil : { ok, texte } (promesse). `input` doit déjà être un objet. `ctx.memberTools` : outils de la personne connectée. */
export async function execTool(name, input, ctx = {}) {
  try {
    if (name === "mes_presences" && ctx.memberTools) {
      const mois = typeof input?.mois === "string" && input.mois ? input.mois : undefined;
      if ((input?.mois !== undefined && input.mois !== "" && mois === undefined) || (mois !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(mois))) return { ok: false, texte: "Format de mois invalide : AAAA-MM attendu (ex. 2019-03)." };
      const r = await ctx.memberTools.mesPresences(mois);
      if (r?.texte) return { ok: true, texte: r.texte };
      return { ok: false, texte: r?.erreur ?? "Historique des présences momentanément indisponible : dis-le simplement et renvoie vers Mon compte – mes présences." };
    }
    if (name === "presence_en_direct") return { ok: true, texte: JSON.stringify(await presenceEnDirect()) };
    if (name === "lire_fiche") return lireFiche(input?.chemin);
    if (name === "chercher") return chercher(input?.mots);
    return { ok: false, texte: "Outil inconnu." };
  } catch {
    return { ok: false, texte: "Erreur interne de l'outil." };
  }
}
