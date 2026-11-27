# Gabarit de mission pour un agent de résumé

À copier dans le prompt d'un sous-agent (adapter les parties entre chevrons). Lancer en arrière-plan, plusieurs lots en parallèle.

```
Tu rédiges une partie du corpus documentaire de Marie-Poule (assistante IA du Coworking Metz).
Dossier de travail : <chemin du dépôt>. LIS D'ABORD `context/_SPEC.md` (consignes obligatoires) puis exécute ta mission.

MISSION « <identifiant-du-lot> » : résume les sources de <périmètre précis : dossiers de docs/, ou pages web listées dans extracted/web/_pages.json>.
<particularités : PDF scannés (statut `vide` dans `extracted/_inventory.json`) à lire visuellement avec l'outil Read ; doublons docx/pdf à ne résumer qu'une fois ; images et .url traités par d'autres agents ; tableurs : structure + totaux + tendances, jamais les lignes>.
Écris tes fichiers dans `context/annees/` (ou `context/sources-web/`), un fichier par année ou grand thème, avec l'en-tête défini dans `_SPEC.md` (titre, periode, sources, type, resume, utile_pour), et l'index `context/_index/<identifiant-du-lot>.md` (une ligne par fichier source).
Longueur visée : ~<N> tokens au total (≈ <3,5 × N> caractères).
Termine par un court rapport : fichiers produits, fichiers non repris avec la raison, doutes et incohérences entre sources.
```

Conseils :
- Donner la longueur visée comme **plafond** : si la source est mince, un résumé court vaut mieux que du remplissage.
- Demander explicitement de signaler (sans trancher) les écarts entre sources : ils alimentent l'étape de validation avec le responsable du projet.
- Pour un lot de pages web : un fichier par type de page (pages, articles, produits, catégories), l'URL canonique dans `sources:`.

## Mission « catalogue et parent INDEX.md » (étape 4) : règle de taille

À ajouter au prompt de l'agent qui écrit `context/INDEX.md` :

```
Budget de taille NON NÉGOCIABLE (le fichier est renvoyé au modèle à chaque question) :
- INDEX.md entier ≤ 9 500 tokens (≈ 29 000 caractères) ; socle ≈ 3 500 tokens ; catalogue ≈ 4 500 tokens.
- Catalogue : 3 colonnes `| chemin | résumé | à charger quand… |`, une ligne par fiche, chemin exact ;
  résumé ≤ 160 caractères ; « à charger quand… » ≤ 120 caractères, mots-clés essentiels seulement.
  Exemple : | `themes/tarifs-et-abonnements.md` | Tarifs en vigueur (boutique, nov. 2026) : 80 €, réduit 60 €, résident 50 €, nomade 15 €, adhésion 10 € ; historique depuis 2016. | prix, tarif étudiant ou demandeur d'emploi, résident, nomade, ancien tarif |
- Aucune redite entre socle, catalogue et « Points à confirmer » ; consignes d'usage en 2 à 3 lignes.
- Termine en lançant `npm run check:context` et corrige jusqu'à ce que le budget soit respecté.
```
