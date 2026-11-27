# Endpoint WordPress `me/summary`

`cowo-me-summary.php` est un mu-plugin WordPress (fichier autonome) qui ajoute la route REST `GET /<préfixe REST>/cowo/v1/me/summary` : une synthèse **minimale** du compte de la personne authentifiée, consommée par le chat (`src/members.js`) avec le jeton OAuth Bearer de la personne.
Le préfixe REST est `wp-json` par défaut (sur le site du coworking : `api-json-wp`, `wp-json` y redirige en 302).

## Principes
- Ne renvoie que les données de l'utilisateur courant : aucun paramètre d'identifiant, un paramètre éventuel est ignoré.
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
