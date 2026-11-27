# Marie-Poule

Assistante IA du Coworking Metz (« Le Poulailler ») : une petite app Node.js (API + frontend) qui répond uniquement aux questions sur le coworking, à partir du corpus `context/`, et refuse poliment le reste.

## Installation et lancement
```
npm install
cp .env.example .env   # puis renseigner CLAUDE_API_KEY
npm start            # http://localhost:3000
npm test             # tests hors ligne (corpus, outils, validation, SSO PKCE avec faux fournisseur, limites) — sans coût
npm run eval         # ~54 questions contre le serveur lancé : COÛT RÉEL (quelques centimes par question)
npm run compare -- --url http://localhost:3100   # idem avec rapport détaillé par fournisseur (voir « Fournisseurs de modèles »)
```

## Fonctionnement
- `POST /api/chat` `{messages:[{role,content}]}` → flux SSE (`delta`, `status`, `error`, `done`). `GET /api/health` (renvoie aussi `provider` et `model`).
- Fournisseur de modèle interchangeable (`PROVIDER`, voir plus bas) ; par défaut Anthropic, effort `low`, streaming. Le prompt (`src/prompt.js`) = cadrage + `context/INDEX.md` (socle + catalogue), mis en cache (1 h). Les fiches arrivent à la demande via les outils `lire_fiche` et `chercher` (3 tours d'outils maximum par question).
- Refus de l'API (`stop_reason: "refusal"`) gérés ; repli serveur `fallbacks: "default"` activé (désactivable avec `FALLBACKS=off`).
- Garde-fous : 8 questions/min/IP, question ≤ 1000 caractères, historique ≤ 10 messages, sortie ≤ 1500 tokens, plafond de dépense estimé par jour (`DAILY_BUDGET_USD`, 5 $ par défaut). Aucun journal des questions n'est tenu ; seuls des compteurs anonymes sont disponibles sur `/api/health`.
- **Aucune conversation n'est conservée côté serveur** : pas de permalink, pas de stockage. L'historique vit dans le navigateur (variable + `sessionStorage` de l'onglet, pour survivre à un rechargement) et le client renvoie les derniers messages à chaque question. Le bouton « Télécharger la conversation (PDF) » (`POST /api/pdf` `{messages}`, 40 messages maximum, généré en mémoire avec `pdfkit`, rien d'écrit ni journalisé, débit `PDF_RATE_LIMIT_PER_MIN`, 30 par défaut) permet de la garder.

## Limite pour les visiteurs anonymes
Un visiteur non connecté peut poser `ANON_MAX_QUESTIONS` questions (5 par défaut). La 6e est refusée par le serveur **sans appel au modèle** (aucun coût) avec un message fixe : journée d'essai gratuite, chat de la page de contact, ou connexion. Le compteur est côté serveur, **sans aucun contenu** : un cookie `mp_anon` (identifiant aléatoire de 128 bits, `HttpOnly`, `SameSite=Lax`, `Secure` en https, 24 h) associé au nombre de questions posées ; un plafond par IP et par jour (`ANON_MAX_QUESTIONS_PER_IP_PER_DAY`, 15 par défaut) limite le contournement par suppression du cookie ; l'historique envoyé ne peut pas contenir plus de questions que la limite. « Nouvelle question » n'efface que l'affichage, pas le compteur. Les compteurs (condensés d'identifiants et d'IP salés, jamais d'IP en clair ni de texte) sont persistés dans `data/` (gitignoré). Derrière un proxy, renseigner `TRUST_PROXY`. Les personnes connectées ne sont pas soumises à cette limite (débit par utilisateur et plafond de dépense restent actifs). Pour `npm run eval` (≈ 45 questions depuis la même IP), lancer le serveur avec `ANON_MAX_QUESTIONS_PER_IP_PER_DAY=1000`.

## Connexion (SSO) et personnalisation
Le bouton « Se connecter » (en haut à droite) lance un flux OAuth2 **Authorization Code + PKCE (S256)** avec un **client public, sans secret**, côté serveur (« backend for frontend ») :
- `GET /auth/login` crée `state`, `code_verifier` (et `nonce` en mode OIDC), les garde **côté serveur** (10 minutes, usage unique) et redirige vers le fournisseur ; `GET /auth/callback` vérifie le `state`, échange le code avec le `code_verifier`, lit l'identité de base, puis crée une session ; `POST /auth/logout` (en-tête `X-Requested-With: fetch`, `Origin` vérifié) la détruit ; `GET /api/me` renvoie uniquement `{ connecte, nom }`.
- Aucun jeton n'atteint le navigateur : il reçoit un cookie opaque (`HttpOnly`, `SameSite=Lax`, `Secure` si `PUBLIC_URL` est en https) ; jetons et session vivent dans `data/sessions/` (gitignoré, fichiers 0600), durée glissante `SESSION_TTL_DAYS` (7), rafraîchissement automatique du jeton. Aucun secret de signature n'est nécessaire.
- Le serveur récupère, avec le jeton de la personne (jamais exposé au navigateur), une synthèse de son compte auprès de `MEMBER_API_URL` (défaut `<SSO_ISSUER>/api-json-wp/cowo/v1/me/summary`, délai 8 s) : adhésion, abonnement, carnets, tarif, statut nomade, présences, statistiques agrégées de fréquentation, achats récents de la boutique et droits (week-end). Il la minimise (liste blanche de champs ; pas d'e-mail, de téléphone, d'adresse ni d'identifiant technique ; au plus 10 achats détaillés), la garde 5 minutes en mémoire (30 s après un échec) et l'ajoute au prompt dans un bloc distinct **après** la partie mise en cache (préfixe identique pour tous). Si l'endpoint est absent, lent ou en erreur, seule l'identité de base est transmise et Marie-Poule dit ce qu'elle ne sait pas ; le chat ne tombe jamais. Rien de personnel n'est journalisé.
- L'endpoint est fourni sous forme de mu-plugin WordPress dans `deploy/wordpress/` (installation, contrat JSON, annulation).

Variables : `SSO_ISSUER` (ex. `https://www.exemple.fr`), `SSO_CLIENT_ID`, `PUBLIC_URL` (adresse publique du chat ; le retour est `${PUBLIC_URL}/auth/callback`), `SSO_SCOPE` (`basic`), `SSO_OIDC`, `MEMBER_API_URL`, `SESSION_TTL_DAYS`. Sans `SSO_ISSUER`, `SSO_CLIENT_ID` et `PUBLIC_URL`, la connexion est désactivée (mode anonyme seulement).

**Enregistrer le client** auprès du fournisseur OAuth2 : type public (aucun secret), type de flux `authorization_code` (+ `refresh_token`), URI de redirection exactes `http://localhost:3000/auth/callback` (développement) et `${PUBLIC_URL}/auth/callback` (production), portée en lecture du profil. Le fournisseur doit accepter PKCE `S256` sans `client_secret`.

## Fournisseurs de modèles
`PROVIDER` choisit le fournisseur (`src/chat.js` délègue à `src/providers/`) :
- `anthropic` (défaut) : API Anthropic, cache du préfixe, `EFFORT`, repli serveur `FALLBACKS`, blocs de réflexion, refus. Variables : `CLAUDE_API_KEY`, `MODEL` (ex. `claude-sonnet-5-5`), `WORKSPACE_ID`.
- `openai-compatible` : tout serveur compatible OpenAI (`POST <LLM_BASE_URL>/chat/completions`, streaming SSE, appels de fonctions), en particulier **OVHcloud AI Endpoints** (modèles ouverts hébergés en France, facturation au token). Variables : `LLM_BASE_URL` (défaut `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1`), `LLM_API_KEY` ou `OVH_AI_ENDPOINTS_ACCESS_TOKEN`, `MODEL` (identifiant exact du modèle, voir `GET <base>/models`), `LLM_TEMPERATURE` (0,2), `LLM_REASONING_EFFORT` (facultatif : `low`, pour gpt-oss…), `LLM_IDLE_TIMEOUT_MS` (45000, sans aucun octet reçu), `LLM_THINK_PREFIXED=1` (modèle qui n'émet que `</think>`), `MAX_OUTPUT_TOKENS` (1000 par défaut, borné à 4000). Le raisonnement du modèle (`<think>…</think>`, `reasoning_content`) n'est jamais affiché ; un `</think>` orphelin efface par `reset` le texte déjà émis. Les erreurs 429/5xx donnent les mêmes messages qu'avec Anthropic ; aucune nouvelle tentative automatique.
- Coût et plafond `DAILY_BUDGET_USD` : `PRICE_INPUT_PER_M` / `PRICE_OUTPUT_PER_M` (USD par million de tokens ; défaut 2 / 10 = Sonnet 5.5, à adapter au modèle utilisé, ex. gpt-oss-120b ≈ 0,09 / 0,47). Cache Anthropic : lecture 0,05 x et écriture 1,25 x le prix d'entrée.

**Deux profils de modèle (anonyme / membre).** Les variables sans préfixe (`PROVIDER`, `MODEL`, `LLM_*`, `MAX_OUTPUT_TOKENS`, `PRICE_*`, `MODEL_LABEL`, `MODEL_HOSTING`) forment le profil **membre**, utilisé pour les personnes connectées (contexte personnalisé `me/summary`). Le profil **anonyme** est facultatif : il existe dès que `ANON_MODEL` (ou `ANON_PROVIDER`) est défini, avec `ANON_PROVIDER`, `ANON_MODEL`, `ANON_LLM_BASE_URL`, `ANON_LLM_API_KEY` (défaut : clé du profil membre / OVH), `ANON_LLM_REASONING_EFFORT`, `ANON_MAX_OUTPUT_TOKENS`, `ANON_PRICE_INPUT_PER_M`, `ANON_PRICE_OUTPUT_PER_M`, `ANON_MODEL_LABEL`, `ANON_MODEL_HOSTING`. Sans profil anonyme, le profil membre sert à tous (comportement historique). Le fournisseur, l'URL, la clé, la température, la limite de sortie et les tarifs sont hérités du profil membre s'ils ne sont pas redéfinis ; l'effort de raisonnement, le libellé et l'hébergement ne le sont pas (pas de mention d'hébergement sans `ANON_MODEL_HOSTING`). Le plafond `DAILY_BUDGET_USD` additionne la dépense des deux profils, chacun avec ses tarifs. Le pied de page (`/api/config`) affiche le modèle du profil qui s'applique à la session, et `/api/health` indique `profils.membre` et `profils.anonyme` (fournisseur et modèle, jamais de clé). Code : `src/profiles.js`, tests : `test/profiles.mjs`.

**Essayer un modèle OVH sans toucher à la production** (serveur de test sur un autre port, variables passées en ligne de commande) :
```
curl -s -H "Authorization: Bearer $OVH_AI_ENDPOINTS_ACCESS_TOKEN" https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models | jq -r '.data[].id'
PORT=3100 PROVIDER=openai-compatible MODEL=<id> OVH_AI_ENDPOINTS_ACCESS_TOKEN=... PRICE_INPUT_PER_M=0.09 PRICE_OUTPUT_PER_M=0.47 \
  ANON_MAX_QUESTIONS_PER_IP_PER_DAY=1000 RATE_LIMIT_PER_MIN=1000 EXPOSE_USAGE=1 node src/server.js
node test/compare.mjs --url http://localhost:3100 --label gpt-oss-120b
```
Faire de même pour Anthropic (`PORT=3101 MODEL=claude-sonnet-5-5 …`, sans `PROVIDER`) puis comparer : `node test/compare.mjs --diff test/rapports/<a>.json test/rapports/<b>.json`. `compare.mjs` pose les ~54 questions de `test/questions.json`, mesure réussite des vérifications grossières, longueur, liens (dont liens ancrés du règlement), refus, latence (1er token, total), tokens et coût estimé, et écrit un rapport JSON + Markdown dans `test/rapports/` (gitignoré). `EXPOSE_USAGE=1` (serveur de test uniquement) fait remonter l'usage par question. Les vérifications automatiques sont grossières : relire les réponses des rapports Markdown avant de conclure. **Comparatif du 2026-11-27** (54 questions, un seul passage, vérifications automatiques grossières ; relues à la main pour les échecs) :

| | Sonnet 5.5 (Anthropic) | gpt-oss-120b (OVH, effort bas) | Mistral-Small-3.2-24B (OVH) | Qwen3.5-397B-A17B (OVH) |
|---|---|---|---|---|
| Réussies | 52/54 (les 2 échecs sont de faux positifs) | 47/54 | 48/54 | 52/54 (2 vrais échecs : aveu d'ignorance sans lien de contact) |
| Liens par réponse (moy.) | 2,1 | 0,8 | 0,6 | 1,1 |
| Lien ancré du règlement (3 cas) | 3/3 | 3/3 | 2/3 | 3/3 |
| Longueur moyenne | 604 car. | 438 | 356 | 529 |
| 1er token médian / total médian | 1,1 s / 2,7 s | 1,1 s / 2,8 s | 0,3 s / 2,9 s | 2,1 s / 3,1 s |
| Coût moyen par question | 0,0087 $ | 0,0023 $ | 0,0021 $ | 0,0228 $ |

Lecture : Qwen3.5-397B est le seul OVH au niveau de Sonnet pour le respect des règles (refus, injections, règlement), mais il coûte 2,6 x plus cher par question que Sonnet (beaucoup de tokens de sortie, prompt de ~29 000 tokens sans cache) et cite moins de liens. gpt-oss-120b et Mistral-Small coûtent ~4 x moins cher que Sonnet mais sourcent peu (moins de liens, pas toujours le lien de contact), refusent à tort ou répondent hors périmètre (élections), et Mistral est le plus rapide. Sonnet reste la référence pour le sourçage ; aucun candidat OVH ne le remplace sans perte de qualité à ce jour. Le gain d'un modèle ouvert est la souveraineté (hébergement en France) plus que le coût, car le prompt de ~30 000 tokens est facturé en entrée à chaque question chez OVH (pas de cache) alors qu'Anthropic le met en cache. Rapports détaillés (réponses comprises) dans `test/rapports/` (local).

**Évaluation avec le prompt allégé (préfixe ≈ 12 100 tokens au lieu de ≈ 18 500, −34 %), 54 questions, `LLM_REASONING_EFFORT=low`, `MAX_OUTPUT_TOKENS=2500`, tarifs OVH du catalogue :**

| | **DeepSeek-V4.1-Flash-1017** (retenu) | Qwen3.5-397B-A17B | qwen3.6-35b-a3b | gemma-4-26b-a4b |
|---|---|---|---|---|
| Réussies | **53/54** | 49/54 | interrompu à 38/54 : 9 échecs | interrompu à 37/54 : 2 échecs |
| Refus attendus | 17/17 | 17/17 | 3 refus manqués sur 38 | - |
| Liens ancrés du règlement | 3/3 | 3/3 | - | - |
| Liens par réponse / lignes | 0,94 / 2,7 | 0,87 / 3,1 | - | - |
| Latence totale médiane / p90 | 1,9 s / 3,7 s | 2,8 s / 9,7 s | 15 à 25 s sur les questions de corpus | 18 à 24 s sur les questions de corpus |
| Tokens entrée / sortie (moy.) | 19 100 / 209 | 20 200 / 588 | - | - |
| Coût par question | **0,0062 $** | 0,0169 $ | ≈ 0,005 $ | ≈ 0,002 $ |
| Avis | Tous les cas sensibles bien traités (injections, farfelu, sanctions, stage 30/90, chaise, Now Coworking). Seul échec : « chatte de l'espace » (réponse juste, mais sans lien de contact). Aucune réponse tronquée, aucun raisonnement affiché, aucune narration avant outil. | Plus lent et 2,7 x plus cher ; 5 échecs (informations manquantes, lien de contact absent, lien « Mon compte » oublié). | Réponses incomplètes sur le bail, le fonds de solidarité, les tarifs ; refus manqués : écarté. | Réponses trop lentes, échecs sur tarifs et essai ; interrompu pour économiser le budget. |

Rappel des mesures du prompt non allégé : Sonnet 5.5 52/54 à 0,87 ct, Qwen3.5-397B 52/54 à 2,28 ct, gpt-oss-120b 47/54 à 0,23 ct, Mistral-Small-3.2 48/54 à 0,21 ct. **Modèle retenu (décision de Gilles) : DeepSeek-V4.1-Flash-1017**, le meilleur score (53/54) pour ≈ 0,6 ct par question. `qwen3.6-35b-a3b` et `gemma-4-26b-a4b` ont été interrompus avant la fin (rapports partiels, non versionnés). Le routage par profil reste disponible mais inactif (aucun `ANON_*` en production).

Les tests hors ligne du fournisseur (faux serveur OpenAI : streaming, outils, JSON invalide, 429, 500, filtre de contenu, raisonnement) sont dans `test/providers.mjs`.

## Variables d'environnement (`MODEL` est obligatoire, ainsi que `CLAUDE_API_KEY` avec `PROVIDER=anthropic` ; les autres sont facultatives)
`PROVIDER`, `LLM_*`, `PRICE_*`, `ANON_*` du profil anonyme (voir « Fournisseurs de modèles »), `MAX_FICHE_CHARS`, `CLAUDE_API_KEY`, `MODEL` (ex. `claude-sonnet-5-5`), `WORKSPACE_ID` (si la clé n'est pas rattachée à un espace de travail), `PORT`, `EFFORT` (low), `MAX_OUTPUT_TOKENS`, `RATE_LIMIT_PER_MIN`, `DAILY_BUDGET_USD`, `CORS_ORIGINS` (liste séparée par des virgules, pour intégrer au site), `TRUST_PROXY` (derrière Apache/nginx), `FALLBACKS=off`, `ANON_MAX_QUESTIONS`, `ANON_MAX_QUESTIONS_PER_IP_PER_DAY`, `PDF_RATE_LIMIT_PER_MIN`, `SSO_*`, `PUBLIC_URL`, `MEMBER_API_URL`, `SESSION_TTL_DAYS` (voir plus haut).

## Déploiement

Node >= 22, un seul process. Exemple avec pm2 et Apache (ou nginx) ; modèles dans `deploy/`.

```
git clone https://github.com/coworking-metz/chat-marie-poule.git && cd chat-marie-poule
npm ci --omit=dev
# copier .env (voir .env.example : PORT, PUBLIC_URL en https, NODE_ENV=production, TRUST_PROXY) et le dossier context/
MP_NODE=/chemin/vers/node22 pm2 start deploy/ecosystem.config.cjs && pm2 save
curl http://127.0.0.1:<PORT>/api/health
```

Reverse proxy : `deploy/apache-vhost.conf.example` ou `deploy/nginx-vhost.conf.example` (proxy vers `127.0.0.1:<PORT>`, **sans tampon pour le flux SSE** de `/api/chat`, délai de lecture >= 120 s, corps limité à 64 Ko, HTTPS Let's Encrypt). `TRUST_PROXY` doit refléter le nombre de proxys devant l'app (sinon la limite par IP est faussée). Mise à jour : `git pull && npm ci --omit=dev && pm2 restart marie-poule`.

## Corpus
Le dossier `context/` (fiches résumées issues des documents et du site de l'association) **n'est pas publié** dans ce dépôt, ni les sources brutes `docs/` et `extracted/`. Sans `context/INDEX.md`, le serveur refuse de démarrer (message explicite) et `npm test` saute les tests dépendant du corpus.

Pour le reconstruire : placer les documents sources dans `docs/` (avec un `docs/sitemap.url` contenant l'URL du sitemap du site), puis suivre le skill `build-context` (`.claude/skills/build-context/SKILL.md`) : `npm run extract`, `npm run crawl`, rédaction des fiches, `npm run build:index`, `npm run check:context`. Les consignes de rédaction (`context/_SPEC.md`) sont à recréer avec le même skill. Le serveur lit `context/` au démarrage : redémarrer après une mise à jour.

## Licence
MIT, voir `LICENSE`.
