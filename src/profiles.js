// Profils de modèle : « membre » (personne connectée, données personnelles) et « anonyme » (facultatif, préfixe ANON_).
// Sans ANON_MODEL ni ANON_PROVIDER, il n'y a qu'un profil : le même modèle pour tous (comportement historique).
// Aucune valeur secrète n'est jamais exposée par ce module (la clé d'API ne sort que vers le fournisseur).
export const PROVIDERS = ["anthropic", "openai-compatible"];
export const DEFAULT_BASE_URL = "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1";

const str = (v) => (v === undefined || v === null ? "" : String(v).trim());
const num = (v, d) => (str(v) !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

/** Premier champ défini parmi les noms donnés (chaîne vide = non défini). */
const first = (env, ...names) => { for (const n of names) if (str(env[n]) !== "") return str(env[n]); return ""; };

/** Profil « membre » : variables sans préfixe (PROVIDER, MODEL, LLM_*, PRICE_*, MODEL_LABEL, MODEL_HOSTING…). */
function memberProfile(env) {
  return {
    name: "membre",
    provider: str(env.PROVIDER) || "anthropic",
    model: str(env.MODEL),
    baseUrl: (str(env.LLM_BASE_URL) || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    apiKey: first(env, "LLM_API_KEY", "OVH_AI_ENDPOINTS_ACCESS_TOKEN"),
    anthropicKey: first(env, "CLAUDE_API_KEY", "ANTHROPIC_API_KEY"),
    reasoningEffort: str(env.LLM_REASONING_EFFORT),
    effort: str(env.EFFORT) || "low", // effort Anthropic
    maxTokens: num(env.MAX_OUTPUT_TOKENS, 0),
    temperature: str(env.LLM_TEMPERATURE) !== "" ? Number(env.LLM_TEMPERATURE) : 0.2,
    thinkPrefixed: env.LLM_THINK_PREFIXED === "1",
    price: { input: num(env.PRICE_INPUT_PER_M, 2), output: num(env.PRICE_OUTPUT_PER_M, 10) }, // défaut : Sonnet 5.5
    label: str(env.MODEL_LABEL),
    hosting: str(env.MODEL_HOSTING),
  };
}

/**
 * Profil « anonyme » : ANON_PROVIDER, ANON_MODEL, ANON_LLM_BASE_URL, ANON_LLM_API_KEY, ANON_LLM_REASONING_EFFORT,
 * ANON_MAX_OUTPUT_TOKENS, ANON_PRICE_INPUT_PER_M, ANON_PRICE_OUTPUT_PER_M, ANON_MODEL_LABEL, ANON_MODEL_HOSTING
 * (+ ANON_LLM_TEMPERATURE, ANON_LLM_THINK_PREFIXED, ANON_EFFORT). Héritage depuis le profil membre : fournisseur, URL de base,
 * clé (OVH par défaut), température, limite de sortie, tarifs. Jamais hérités, car propres à un modèle : effort de raisonnement,
 * balise de raisonnement, libellé et mention d'hébergement (pas d'affirmation fausse en pied de page).
 */
function anonProfile(env, m) {
  if (first(env, "ANON_MODEL", "ANON_PROVIDER") === "") return null;
  const provider = str(env.ANON_PROVIDER) || m.provider;
  const model = str(env.ANON_MODEL) || m.model; // ANON_PROVIDER seul : même identifiant de modèle, autre fournisseur
  return {
    name: "anonyme",
    provider,
    model,
    baseUrl: (str(env.ANON_LLM_BASE_URL) || m.baseUrl).replace(/\/+$/, ""),
    apiKey: first(env, "ANON_LLM_API_KEY") || m.apiKey,
    anthropicKey: m.anthropicKey,
    reasoningEffort: str(env.ANON_LLM_REASONING_EFFORT),
    effort: str(env.ANON_EFFORT) || "low",
    maxTokens: num(env.ANON_MAX_OUTPUT_TOKENS, m.maxTokens),
    temperature: str(env.ANON_LLM_TEMPERATURE) !== "" ? Number(env.ANON_LLM_TEMPERATURE) : m.temperature,
    thinkPrefixed: env.ANON_LLM_THINK_PREFIXED === "1",
    price: { input: num(env.ANON_PRICE_INPUT_PER_M, m.price.input), output: num(env.ANON_PRICE_OUTPUT_PER_M, m.price.output) },
    label: str(env.ANON_MODEL_LABEL),
    hosting: str(env.ANON_MODEL_HOSTING),
  };
}

/** { membre, anonyme } ; `anonyme` vaut null s'il n'est pas configuré (les anonymes utilisent alors le profil membre). */
export function resolveProfiles(env = process.env) {
  const membre = memberProfile(env);
  return { membre, anonyme: anonProfile(env, membre) };
}

/** Profil qui s'applique à une personne : connectée -> membre ; sinon anonyme si défini, membre sinon. */
export const profileFor = (profiles, connected) => (connected ? profiles.membre : profiles.anonyme ?? profiles.membre);

/** Message d'erreur de configuration (chaîne) ou null. */
export function validateProfiles({ membre, anonyme }) {
  for (const p of [membre, anonyme].filter(Boolean)) {
    const pre = p.name === "anonyme" ? "ANON_" : "";
    if (!PROVIDERS.includes(p.provider)) return `${pre}PROVIDER inconnu : « ${p.provider} » (attendu : anthropic ou openai-compatible).`;
    if (!p.model) return `${pre}MODEL manquant : ajoutez ${pre}MODEL=… (identifiant du modèle du fournisseur) dans .env.`;
  }
  return null;
}

/** Description publique (sans clé) : { provider, model }. */
export const describe = (p) => ({ provider: p.provider, model: p.model });

/** Contenu de /api/config pour un profil : libellé lisible (sinon identifiant) et hébergement (seulement s'il est défini). */
export const publicConfig = (p) => ({ model: p.label || p.model, hosting: p.hosting || null });
