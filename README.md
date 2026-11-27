# Marie-Poule

Assistante IA du Coworking Metz (« Le Poulailler ») : une petite app Node.js (API + frontend) qui répond uniquement aux questions sur le coworking, à partir du corpus `context/`, et refuse poliment le reste.

## Installation et lancement
```
npm install
cp .env.example .env   # puis renseigner CLAUDE_API_KEY
npm start            # http://localhost:3000
npm test             # tests hors ligne (corpus, outils, validation) — sans coût
npm run eval         # ~45 questions contre l'API : COÛT RÉEL (quelques centimes par question), serveur lancé
```

## Fonctionnement
- `POST /api/chat` `{messages:[{role,content}]}` → flux SSE (`delta`, `status`, `error`, `done`). `GET /api/health`.
- Modèle `claude-opus-5-5`, effort `low`, streaming. Le prompt (`src/prompt.js`) = cadrage + `context/INDEX.md` (socle + catalogue), mis en cache (1 h). Les fiches arrivent à la demande via les outils `lire_fiche` et `chercher` (3 tours d'outils maximum par question).
- Refus de l'API (`stop_reason: "refusal"`) gérés ; repli serveur `fallbacks: "default"` activé (désactivable avec `FALLBACKS=off`).
- Garde-fous : 8 questions/min/IP, question ≤ 1000 caractères, historique ≤ 10 messages, sortie ≤ 1500 tokens, plafond de dépense estimé par jour (`DAILY_BUDGET_USD`, 5 $ par défaut). Aucun texte de question n'est journalisé ; seuls des compteurs anonymes sont disponibles sur `/api/health`.

## Variables d'environnement (toutes facultatives sauf la clé)
`CLAUDE_API_KEY`, `WORKSPACE_ID` (si la clé n'est pas rattachée à un espace de travail), `PORT`, `MODEL`, `EFFORT` (low), `MAX_OUTPUT_TOKENS`, `RATE_LIMIT_PER_MIN`, `DAILY_BUDGET_USD`, `CORS_ORIGINS` (liste séparée par des virgules, pour intégrer au site), `TRUST_PROXY` (derrière Apache/nginx), `FALLBACKS=off`.

## Corpus
Le dossier `context/` (fiches résumées issues des documents et du site de l'association) **n'est pas publié** dans ce dépôt, ni les sources brutes `docs/` et `extracted/`. Sans `context/INDEX.md`, le serveur refuse de démarrer (message explicite) et `npm test` saute les tests dépendant du corpus.

Pour le reconstruire : placer les documents sources dans `docs/` (avec un `docs/sitemap.url` contenant l'URL du sitemap du site), puis suivre le skill `build-context` (`.claude/skills/build-context/SKILL.md`) : `npm run extract`, `npm run crawl`, rédaction des fiches, `npm run build:index`, `npm run check:context`. Les consignes de rédaction (`context/_SPEC.md`) sont à recréer avec le même skill. Le serveur lit `context/` au démarrage : redémarrer après une mise à jour.

## Licence
MIT, voir `LICENSE`.
