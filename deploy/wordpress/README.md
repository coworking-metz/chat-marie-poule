# Endpoint WordPress `me/summary`

`cowo-me-summary.php` est un mu-plugin WordPress (fichier autonome) qui ajoute la route REST `GET /<préfixe REST>/cowo/v1/me/summary` : une synthèse **minimale** du compte de la personne authentifiée, consommée par le chat (`src/members.js`) avec le jeton OAuth Bearer de la personne.
Le préfixe REST est `wp-json` par défaut (sur le site du coworking : `api-json-wp`, `wp-json` y redirige en 302).

## Principes
- Ne renvoie que les données de l'utilisateur courant : aucun paramètre d'identifiant, un paramètre éventuel est ignoré (vaut pour `me/summary` comme pour `me/presences`).
- Authentification : session WordPress ou jeton Bearer reconnu par le serveur OAuth (filtre `determine_current_user`). Sans authentification : 401, aucune donnée.
- Jamais d'e-mail, téléphone, adresse, date de naissance, nom de famille, identifiant technique, numéro de commande ni clé.
- Une source indisponible ne provoque pas d'erreur 500 : les champs valent `null` et la section est listée dans `indisponible`.
- `Cache-Control: no-store, private`, `Vary: Authorization, Cookie` ; cache serveur (transient) de 60 s par utilisateur (15 s si réponse partielle) ; délai d'attente de 5 s par appel au service tickets.
- Prérequis : constantes `TICKET_BASE_URL` et `API_KEY_TICKET` (service tickets), WooCommerce, et, pour le statut nomade, les fonctions `isNomade()` et `get_dates_nomade_user()` du site (sinon `nomade` vaut `null`).

## Installation
1. `php -l cowo-me-summary.php` avec la version de PHP du site.
2. Copier le fichier dans `wp-content/mu-plugins/` sous un nom temporaire non `.php` puis le renommer (copie atomique) ; vérifier aussitôt que le site et l'API REST répondent.
3. Test : sans jeton la route renvoie 401.

## Annulation
Supprimer `wp-content/mu-plugins/cowo-me-summary.php` (rien d'autre n'est modifié ; les transients `cowo_ms_*` expirent seuls).

## Contrat JSON
```json
{
  "prenom": "Camille",
  "membre_depuis": "2019-03-04",
  "adherent": { "a_jour": true, "derniere_annee": 2026, "fin": "2026-12-31" },
  "abonnement": { "en_cours": true, "debut": "2026-11-01", "fin": "2026-11-30", "duree_jours": 30, "jours_restants": 3 },
  "carnets": { "solde": 4.5 },
  "tarif": { "type": "normal|reduit|resident", "reduit": false, "resident_blida": false },
  "nomade": { "actif": false, "dates_a_venir": ["2026-12-02"], "derniere_date": "2026-10-10" },
  "presences": { "jours_30": 8, "jours_90": 21, "total": 120, "derniere_venue": "2026-11-25" },
  "statistiques": {
    "par_mois_12": [{ "mois": "2025-12", "jours": 5 }],
    "moyenne_mensuelle_12": 6.5,
    "par_jour_semaine": { "lundi": 10, "mardi": 12, "mercredi": 8, "jeudi": 9, "vendredi": 3, "samedi": 0, "dimanche": 0 },
    "mois_record": { "mois": "2026-03", "jours": 15 },
    "premiere_venue": "2019-04-02", "total_jours": 120, "semaines_consecutives": 3,
    "types": { "abonnement": 80, "carnet": 40, "nomade": 0 }
  },
  "achats": [{ "date": "2026-11-01", "produit": "Abonnement 30 jours", "categorie": "abonnement", "quantite": 1, "montant_ttc": 80.0, "statut": "termine|paye" }],
  "achats_resume": { "commandes": 12, "articles": 14, "total_ttc": 640.0, "par_categorie": { "abonnement": { "quantite": 6, "montant_ttc": 480.0 } }, "depuis": "2019-04-01", "complet": true, "plus_anciens": 0 },
  "droits": { "week_end": true, "seuil_week_end": 10, "jours_manquants_week_end": 0 },
  "indisponible": [],
  "maj": "2026-11-27T10:00:00+00:00"
}
```
- Sections absentes ou indisponibles : `null` (et nom listé dans `indisponible` : `adhesion`, `abonnement`, `carnets`, `tarif`, `presences`, `droits`, `nomade`, `achats`).
- `achats` : 30 derniers articles de commandes payées ou terminées, du plus récent au plus ancien ; `categorie` : `abonnement|carnet|nomade|adhesion|contribution|impression|autre` ; `plus_anciens` : articles non listés (approximatif au-delà de 100 commandes).
- `statistiques` : agrégats seulement, jamais la liste brute des présences.

## Route `me/presences` (historique complet, ajoutée le 2026-11-27 dans le même fichier)
`GET /api-json-wp/cowo/v1/me/presences[?mois=AAAA-MM]` : détail des venues PASSÉES de la personne authentifiée (outil `mes_presences` du chat). `me/summary` n'est pas alourdi et son contrat est inchangé.
- Source : liste complète des présences du service tickets (`/members/{id}/activity`, une entrée par jour avec `date`, `value` (1 ou 0,5), `type`) : tout l'historique, depuis la première venue ; ~200 octets par jour (un millier de jours ≈ 200 Ko lus côté serveur, ≈ 50 ms pour 200 jours), jamais renvoyé en entier. Les journées « nomades » ne sont pas dans cette source.
- Mêmes protections que `me/summary` (401 sans authentification, `Cache-Control: no-store, private`, `Vary: Authorization, Cookie`, erreurs sans détail) ; délai de 3 s vers le service tickets ; cache transient de 60 s par utilisateur et par paramètre (succès seulement). Source en échec : 503 `cowo_indisponible`.
- `mois` : `AAAA-MM`, pas avant 2014-01, pas dans le futur ; sinon 400 `cowo_mois_invalide`.

Sans paramètre : historique compact (`null` = avant la première venue ou mois à venir, `0` = aucune venue ; demi-journées : valeurs en `x,5`).
```json
{ "premiere_venue": "2019-03-04", "total": 120,
  "total_par_annee": { "2019": 54, "2020": 30 },
  "historique_mensuel": { "2019": [null, null, 7, 5, 6, 4, 3, 2, 8, 9, 6, 4], "2020": [5, 0, 3, 2, 1, 4, 6, 3, 2, 1, 2, 1] },
  "mis_a_jour": "2026-11-27T10:00:00+00:00" }
```
Avec `?mois=2019-03` :
```json
{ "mois": "2019-03", "nb_jours": 7, "jours": ["2019-03-04", "2019-03-05"], "demi_journees": [], "mis_a_jour": "2026-11-27T10:00:00+00:00" }
```
Déploiement : même procédure (sauvegarde hors `mu-plugins`, `php -l`, copie atomique, contrôle de `/` et `/api-json-wp/`). Annulation : restaurer la sauvegarde `cowo-me-summary.php.bak-avant-historique` (la route `me/presences` disparaît, rien d'autre ne change).

# Endpoint WordPress `presence-now`

`cowo-presence-now.php` (mu-plugin autonome, déployé le 2026-11-27) ajoute la route publique `GET /api-json-wp/cowo/v1/presence-now` : la présence en direct en JSON, sans HTML, consommée par l'outil `presence_en_direct` du chat (`PRESENCE_URL`).

- Source : la même que `coworkers_now` (nombre d'éléments de `{TICKET_BASE_URL}/current-members`, clé du site jamais exposée), capacité `COWORKING_NB_PLACES` (40). Délai d'attente 3 s. Aucun nom, identifiant ni appareil dans la réponse.
- Public, lecture seule, sans paramètre. Source en échec : HTTP 200, `presents`/`libres` à `null`, `indisponible: true`.
- Cache : transient WordPress de 30 s (10 s si échec) ; `Cache-Control: public, max-age=30, s-maxage=30` (Cloudflare).
- Installation : `php -l`, copie atomique (`.tmp` puis `mv`) dans `wp-content/mu-plugins/`, vérifier `/` et `/api-json-wp/` (200 ; `/wp-json/` répond 302, normal). Annulation : supprimer ce seul fichier.

```json
{ "presents": 14, "capacite": 40, "libres": 26, "estimation": true, "delai_minutes": 10, "mis_a_jour": "2026-11-27T12:03:23+01:00", "indisponible": false }
```
`estimation` vaut toujours `true` (appareils enregistrés vus sur le wifi depuis moins de `delai_minutes` minutes) ; `mis_a_jour` est en heure de Paris.
