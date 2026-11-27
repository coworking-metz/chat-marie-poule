// Point d'entrée du chat : choisit le profil de modèle puis le fournisseur, et lui délègue.
//   PROVIDER=anthropic          (défaut) API Anthropic -> src/providers/anthropic.js
//   PROVIDER=openai-compatible  OVH AI Endpoints ou tout serveur compatible OpenAI -> src/providers/openai.js
// Deux profils (src/profiles.js) : « membre » (variables sans préfixe) pour les personnes connectées et « anonyme »
// (variables ANON_*, facultatif) pour les visiteurs anonymes ; sans profil anonyme, le profil membre sert à tous.
// Générateur d'événements : { type: "delta"|"reset"|"status"|"refused"|"usage"|"error"|"done", ... }.
import { FAILURE_TEXT } from "./providers/common.js";
import { resolveProfiles, profileFor, validateProfiles } from "./profiles.js";

export const PROFILES = resolveProfiles(process.env);
const erreur = validateProfiles(PROFILES);
if (erreur) {
  console.error(erreur);
  process.exit(1);
}
export const PROVIDER = PROFILES.membre.provider;
export const MODEL = PROFILES.membre.model;

const modules = { anthropic: "./providers/anthropic.js", "openai-compatible": "./providers/openai.js" };
const runners = new Map(); // profil -> exécuteur (créé à la première utilisation)
async function runnerFor(profile) {
  if (!runners.has(profile)) runners.set(profile, (await import(modules[profile.provider])).createRunner(profile));
  return runners.get(profile);
}

/**
 * `history` = messages {role, content:string} déjà validés. `opts.connected` : personne connectée (profil membre) ou
 * visiteur anonyme (profil anonyme s'il existe). `opts.memberBlock` : contexte personnalisé du membre.
 */
export async function* chat(history, signal, opts = {}) {
  let run;
  try {
    run = await runnerFor(profileFor(PROFILES, !!opts.connected));
  } catch (e) {
    console.error("[chat] initialisation du fournisseur impossible", e?.constructor?.name);
    yield { type: "error", text: FAILURE_TEXT };
    return;
  }
  yield* run(history, signal, opts);
}
