# Marie-Poule

Assistante IA du Coworking Metz (« Le Poulailler ») : une petite app Node.js (API + frontend) qui répond uniquement aux questions sur le coworking, à partir du corpus `context/`, et refuse poliment le reste.

## Installation et lancement
```
npm install
cp .env.example .env   # puis renseigner CLAUDE_API_KEY
npm start            # http://localhost:3000
npm test             # tests hors ligne (corpus, outils, validation, SSO PKCE avec faux fournisseur, limites) — sans coût
npm run eval         # ~45 questions contre l'API : COÛT RÉEL (quelques centimes par question), serveur lancé
```

## Fonctionnement
- `POST /api/chat` `{messages:[{role,content}]}` → flux SSE (`delta`, `status`, `error`, `done`). `GET /api/health`.
- Modèle `claude-opus-5-5`, effort `low`, streaming. Le prompt (`src/prompt.js`) = cadrage + `context/INDEX.md` (socle + catalogue), mis en cache (1 h). Les fiches arrivent à la demande via les outils `lire_fiche` et `chercher` (3 tours d'outils maximum par question).
- Refus de l'API (`stop_reason: "refusal"`) gérés ; repli serveur `fallbacks: "default"` activé (désactivable avec `FALLBACKS=off`).
- Garde-fous : 8 questions/min/IP, question ≤ 1000 caractères, historique ≤ 10 messages, sortie ≤ 1500 tokens, plafond de dépense estimé par jour (`DAILY_BUDGET_USD`, 5 $ par défaut). Aucun journal des questions n'est tenu ; seuls des compteurs anonymes sont disponibles sur `/api/health`.
- **Aucune conversation n'est conservée côté serveur** : pas de permalink, pas de stockage. L'historique vit dans le navigateur (variable + `sessionStorage` de l'onglet, pour survivre à un rechargement) et le client renvoie les derniers messages à chaque question. Le bouton « Télécharger la conversation (PDF) » (`POST /api/pdf` `{messages}`, 40 messages maximum, généré en mémoire avec `pdfkit`, rien d'écrit ni journalisé, débit `PDF_RATE_LIMIT_PER_MIN`, 30 par défaut) permet de la garder.

## Limite pour les visiteurs anonymes
Un visiteur non connecté peut poser `ANON_MAX_QUESTIONS` questions (5 par défaut). La 6e est refusée par le serveur **sans appel au modèle** (aucun coût) avec un message fixe : journée d'essai gratuite, chat de la page de contact, ou connexion. Le compteur est côté serveur, **sans aucun contenu** : un cookie `mp_anon` (identifiant aléatoire de 128 bits, `HttpOnly`, `SameSite=Lax`, `Secure` en https, 24 h) associé au nombre de questions posées ; un plafond par IP et par jour (`ANON_MAX_QUESTIONS_PER_IP_PER_DAY`, 15 par défaut) limite le contournement par suppression du cookie ; l'historique envoyé ne peut pas contenir plus de questions que la limite. « Nouvelle question » n'efface que l'affichage, pas le compteur. Les compteurs (condensés d'identifiants et d'IP salés, jamais d'IP en clair ni de texte) sont persistés dans `data/` (gitignoré). Derrière un proxy, renseigner `TRUST_PROXY`. Les personnes connectées ne sont pas soumises à cette limite (débit par utilisateur et plafond de dépense restent actifs). Pour `npm run eval` (≈ 45 questions depuis la même IP), lancer le serveur avec `ANON_MAX_QUESTIONS_PER_IP_PER_DAY=1000`.

## Connexion (SSO) et personnalisation
Le bouton « Se connecter » (en haut à droite) lance un flux OAuth2 **Authorization Code + PKCE (S256)** avec un **client public, sans secret**, côté serveur (« backend for frontend ») :
- `GET /auth/login` crée `state`, `code_verifier` (et `nonce` en mode OIDC), les garde **côté serveur** (10 minutes, usage unique) et redirige vers le fournisseur ; `GET /auth/callback` vérifie le `state`, échange le code avec le `code_verifier`, lit l'identité de base, puis crée une session ; `POST /auth/logout` (en-tête `X-Requested-With: fetch`, `Origin` vérifié) la détruit ; `GET /api/me` renvoie uniquement `{ connecte, nom }`.
- Aucun jeton n'atteint le navigateur : il reçoit un cookie opaque (`HttpOnly`, `SameSite=Lax`, `Secure` si `PUBLIC_URL` est en https) ; jetons et session vivent dans `data/sessions/` (gitignoré, fichiers 0600), durée glissante `SESSION_TTL_DAYS` (7), rafraîchissement automatique du jeton. Aucun secret de signature n'est nécessaire.
- Le serveur récupère, avec le jeton de la personne, une synthèse de son compte (abonnement, tickets, fréquentation, adhésion…) auprès de `MEMBER_API_URL`, la minimise (pas d'e-mail, de téléphone, d'adresse ni d'identifiant technique), la garde 5 minutes en mémoire et l'ajoute au prompt dans un bloc distinct **après** la partie mise en cache. Sans cet endpoint, seule l'identité de base est transmise et Marie-Poule indique ce qu'elle ne sait pas. Rien de personnel n'est journalisé.

Variables : `SSO_ISSUER` (ex. `https://www.exemple.fr`), `SSO_CLIENT_ID`, `PUBLIC_URL` (adresse publique du chat ; le retour est `${PUBLIC_URL}/auth/callback`), `SSO_SCOPE` (`basic`), `SSO_OIDC`, `MEMBER_API_URL`, `SESSION_TTL_DAYS`. Sans `SSO_ISSUER`, `SSO_CLIENT_ID` et `PUBLIC_URL`, la connexion est désactivée (mode anonyme seulement).

**Enregistrer le client** auprès du fournisseur OAuth2 : type public (aucun secret), type de flux `authorization_code` (+ `refresh_token`), URI de redirection exactes `http://localhost:3000/auth/callback` (développement) et `${PUBLIC_URL}/auth/callback` (production), portée en lecture du profil. Le fournisseur doit accepter PKCE `S256` sans `client_secret`.

## Variables d'environnement (`CLAUDE_API_KEY` et `MODEL` sont obligatoires, les autres facultatives)
`CLAUDE_API_KEY`, `MODEL` (ex. `claude-opus-5-5`), `WORKSPACE_ID` (si la clé n'est pas rattachée à un espace de travail), `PORT`, `EFFORT` (low), `MAX_OUTPUT_TOKENS`, `RATE_LIMIT_PER_MIN`, `DAILY_BUDGET_USD`, `CORS_ORIGINS` (liste séparée par des virgules, pour intégrer au site), `TRUST_PROXY` (derrière Apache/nginx), `FALLBACKS=off`, `ANON_MAX_QUESTIONS`, `ANON_MAX_QUESTIONS_PER_IP_PER_DAY`, `PDF_RATE_LIMIT_PER_MIN`, `SSO_*`, `PUBLIC_URL`, `MEMBER_API_URL`, `SESSION_TTL_DAYS` (voir plus haut).

## Corpus
Le dossier `context/` (fiches résumées issues des documents et du site de l'association) **n'est pas publié** dans ce dépôt, ni les sources brutes `docs/` et `extracted/`. Sans `context/INDEX.md`, le serveur refuse de démarrer (message explicite) et `npm test` saute les tests dépendant du corpus.

Pour le reconstruire : placer les documents sources dans `docs/` (avec un `docs/sitemap.url` contenant l'URL du sitemap du site), puis suivre le skill `build-context` (`.claude/skills/build-context/SKILL.md`) : `npm run extract`, `npm run crawl`, rédaction des fiches, `npm run build:index`, `npm run check:context`. Les consignes de rédaction (`context/_SPEC.md`) sont à recréer avec le même skill. Le serveur lit `context/` au démarrage : redémarrer après une mise à jour.

## Licence
MIT, voir `LICENSE`.
