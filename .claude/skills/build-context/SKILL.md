---
name: build-context
description: Construit ou met à jour le corpus de Marie-Poule (dossier context/) à partir de docs/ (tous formats, dont les .url), du sitemap du site et des pages qu'il liste. À utiliser quand de nouveaux documents sont ajoutés à docs/, quand le site a changé, ou pour reconstruire le corpus de zéro.
---

# Construire le corpus `context/` de Marie-Poule

Objectif : transformer les sources brutes (`docs/` et le site public) en **fiches Markdown résumées mais exhaustives** dans `context/`, organisées en arbre : un fichier **parent** `context/INDEX.md` (socle + catalogue) et des **fiches enfants** que l'IA charge seulement si la question s'y prête. Les comptes et comptes rendus de l'association sont **publics** ; la seule limite est la protection des identifiants personnels.

Tout ce qui est généré hors de `context/` (`extracted/`) est **gitignoré et régénérable**. `docs/` n'est jamais modifié ni versionné.

## Prérequis
`python3`, `pdftotext` (poppler), `curl`, `node` ≥ 22, ImageMagick (`convert`) pour les images/HEIC, accès réseau pour le site. Ne jamais lire ni afficher `.env`.

## Les 6 étapes

### 1. Extraire le texte de `docs/`
```
npm run extract          # python3 scripts/extract.py
```
Produit `extracted/<chemin>.txt` pour chaque document (docx, pptx/pptm, xlsx/xlsm, odt, pdf, csv, txt, json, gform) et `extracted/_inventory.json` (statut, taille, empreinte `sha1`). Statuts : `ok`, `vide` (PDF scanné : à lire visuellement), `image`, `url`, `erreur`, `format-inconnu`. À la relance, le script affiche les fichiers **nouveaux / modifiés / supprimés** depuis l'inventaire précédent (`_inventory.prev.json`) : c'est la liste de travail d'une mise à jour.

### 2. Parcourir le site à partir de `docs/sitemap.url`
```
npm run crawl            # python3 scripts/crawl-sitemap.py
```
Lit l'URL du sitemap dans `docs/sitemap.url`, descend dans **tous les sous-sitemaps**, télécharge **chaque page listée** (HTML ou PDF) avec `curl` (pause entre les requêtes), en extrait le texte utile et écrit `extracted/web/<chemin>.txt` + `extracted/web/_pages.json`. Les autres `.url` (règlement intérieur, Google Sheets, Canva) sont lus par l'agent « url » (étape 3) ; une feuille privée (HTTP 401) est signalée : demander un export CSV au propriétaire. La présentation Canva (« Stats 2023 ») est volontairement ignorée (choix du projet) : ne pas la relancer.

### 3. Répartir le travail entre agents (en parallèle, en arrière-plan)
Utiliser `extracted/_inventory.json` et `extracted/web/_pages.json` pour découper en lots de **≤ ~80 000 tokens de texte brut** (≈ 280 000 caractères) :

| Lot | Contenu | Longueur visée du résumé |
|---|---|---|
| par année ou groupe d'années | `docs/CA <année>/…` (hors images et `.url`) | ~10 à 35 % du brut, jamais de remplissage |
| années lourdes | scinder : finances + statistiques / réunions + AG | idem |
| images | toutes les images de `docs/` (vignettes, jamais en pleine résolution) | ~5 000 tokens |
| `.url` | règlement intérieur, feuilles, présentations | règlement quasi complet |
| pages du site | pages, articles, produits, catégories du sitemap | par type de page |

Chaque agent lit **d'abord** `context/_SPEC.md` (format d'en-tête, ce qu'on garde, masquage RGPD, index d'agent) puis sa mission. Gabarit de mission : `references/mission-template.md`. Les lots tournent en parallèle (`run_in_background`), chacun écrit dans `context/annees/` (ou `context/sources-web/`, `context/images/`) et son index `context/_index/<lot>.md` (une ligne par fichier source : `résumé`, `non repris (doublon)`, `illisible`…).

### 4. Construire l'arbre : fiches thématiques + parent `INDEX.md`
Un agent relit tous les résumés et :
1. ajoute à chaque fiche `resume` et `utile_pour` dans son en-tête (si absents) ;
2. écrit des **fiches de synthèse thématiques** : tarifs et abonnements, fonctionnement et règles, espace et services, histoire et chiffres clés, gouvernance, finances, fréquentation, FAQ pratique… (information **la plus récente d'abord**, ancienne information datée) ;
3. rédige le **socle** (≈ 4 000 à 6 000 tokens : présentation, tarifs actuels, horaires et accès, règles essentielles, comment venir essayer, chiffres clés, liens) ;
4. génère `context/INDEX.md` = cadrage éditorial court + socle + **catalogue** (chemin, titre, période, résumé, « à charger quand… ») puis `npm run build:index` (génère `context/_TRACE.md` : traçabilité fusionnée des index d'agents, non lue par l'IA ; `INDEX.md` reste le parent rédigé).

Les fichiers et dossiers qui commencent par `_` (`_SPEC.md`, `_index/`) ne font pas partie du corpus de l'IA.

### 5. Contrôler
```
npm run check:context
```
Vérifie : en-têtes valides, **chaque source (docs et pages web) citée dans un index**, taille estimée en tokens, absence d'e-mails (hors `contact@coworking-metz.fr`), téléphones, IBAN, numéros de sécu. Corriger jusqu'à « Tout est conforme ». Relire ensuite à la main un échantillon (chiffres clés, tarifs actuels, règles).

### 6. Valider avec le responsable du projet
Présenter : décompte des sources (intégrées / non reprises / illisibles), liste des **contradictions et doutes** remontés par les agents (ils les signalent dans leur rapport), sources inaccessibles (demander un export). Ne rien publier avant accord.

## Mise à jour incrémentale (nouveaux documents ou site modifié)
1. `npm run extract` : noter les fichiers NOUVEAU / MODIFIÉ / SUPPRIMÉ ; `npm run crawl` pour le site (comparer `lastmod` dans `_pages.json`).
2. Ne relancer des agents **que** sur le périmètre touché : mettre à jour le résumé concerné (conserver son nom de fichier), mettre à jour son index d'agent.
3. Refaire l'étape 4 (synthèses concernées + `INDEX.md`) puis 5.
4. Faits datés : quand une information change (tarif, loyer, composition du CA), **la fiche thématique garde la valeur actuelle** et l'historique reste dans la fiche d'année.

## Règles à ne jamais oublier
- Exhaustif mais condensé : chiffres, dates, décisions, votes agrégés, tarifs, règles ; pas de remplissage.
- Ne pas inventer ; `(lecture incertaine)` quand une lecture est douteuse ; signaler les incohérences entre sources au lieu de trancher.
- Masquer e-mails, téléphones, adresses de particuliers, IBAN, dates de naissance ; pas de liste nominative de présents/votants ; ne jamais décrire l'apparence de personnes sur des photos.
- Pour inviter à écrire à l'association, renvoyer vers la **page de contact** du site, jamais vers un e-mail.
- Aucun commit sans demande ; ne pas utiliser `pkill`.
