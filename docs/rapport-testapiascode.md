# Rapport d'essai TestApiAsCode : recréer le backend Radar Immo

Compte de test : `ClaudeAssistant` (viewer, author, publisher, rule-maintainer). Tables : `server/sql/schema.sql` (schéma `radar_immo`).

**Objectif :** recréer le backend existant (`server/src/app.js` + `store.js`, Fastify + PostgreSQL) sous forme de routes TestApiAsCode.

Deux passes ont eu lieu le 2026-10-08 :
1. **Passe 1** (version initiale de l'outil) : 7 blocages, détaillés en annexe.
2. **Passe 2** (après évolution de l'outil) : presque tous les blocages sont levés, 14 routes sont écrites et testées en brouillon. Rien n'est publié.

## Verdict de la passe 2

Le backend peut être reproduit, avec quelques écarts de contrat et une limite de concurrence. Toutes les routes que l'extension appelle réellement (`/v1/me`, `/v1/sync`, `/v1/shares` ×3, `/v1/data`) sont faites et leurs tests de simulation passent.

## Routes écrites (brouillons, tous testés avec succès)

| Brouillon | Route | Technique | Ce qui est vérifié en simulation |
|---|---|---|---|
| 17 | `GET /health` | `respond` seul | réponse |
| 4 | `GET /v1/me` | `respond` + `$user.id` | réponse |
| 5 | `GET /v1/settings` | étape `code` | cas « aucun critère » (null) |
| 3 | `PUT /v1/settings` | `target` + `upsert` + `$nextval` + `code` (dernière écriture gagne) | insertion complète, avec utilisateur créé |
| 6 | `GET /v1/listings` | `target` + `scope` + `list` (tri, offset, total) | liste vide |
| 7 | `GET /v1/listings/{id}` | `target` + `scope` | 404 |
| 10 | `PATCH /v1/listings/{id}` | `code` + `$merge` + `$nextval` | 404, aucun champ, enum invalide |
| 8 | `DELETE /v1/listings/{id}` | `code` (tombe + version) | 404 |
| 9 | `POST /v1/sync` | `code` + `upsert` + `$nextval` | première synchro (2 annonces + critères), synchro vide, 400 |
| 11 | `POST /v1/shares` | `code` + `randomToken` | 404, validation (365 jours max) |
| 12 | `GET /v1/shares` | `code` | liste vide |
| 13 | `DELETE /v1/shares/{token}` | `code` | 404 |
| 14 | `DELETE /v1/data` | `code` (mise à jour en masse avec `$nextval` par ligne) | compte vide, 204 |
| 15 | `GET /v1/export` | `code` (pagination par `offset`) | compte vide |
| 16 | `GET /public/shares/{token}` | `code`, `access: public` | jeton invalide / inconnu |

Les chemins heureux qui exigent des lignes existantes (PATCH, DELETE, création de lien, vue publique) ont été vérifiés **par une route-sonde** qui amorce des données puis exécute les mêmes appels `ctx.db` (voir P1). Elle a confirmé : `$merge` (fusion JSON superficielle, comme `data || patch`), `$increment`, `$now` (`epoch_ms`, `timestamp`), `$nextval` (une valeur distincte par ligne sur 130 lignes), mise à jour des colonnes générées `saved`/`status`, `randomToken(16)` (22 caractères, base64url, 128 bits), filtres `isNull`/`gt`/`lte`, `offset`, `limit` jusqu'à 1000.

## Ce qui est résolu depuis la passe 1

| Blocage de la passe 1 | État |
|---|---|
| B1 séquence / valeur serveur | résolu : `{ $nextval: schéma.séquence }` dans `map`, `softDelete` et `ctx.db` ; `GET /v1/data/sequences` |
| B2 upsert | résolu : `upsert: true` et `ctx.db.upsert(table, valeurs, clés, colonnesÀMettreÀJour)` |
| B4 expressions de mise à jour | résolu : `$increment`, `$now`, `$merge` |
| B5 pagination et tri | résolu : `offset`, `list` avec tri et total, `orderBy` |
| B6 authentification | documentée : `AUTH_VERIFY_URL` / JWT / clé d'API (configuration du serveur de l'outil, non testable depuis l'API de gestion) |
| B7 réponse 204 | résolu : `respond: { status: 204 }` sans corps |
| Jetons aléatoires | résolu : `ctx.randomToken()` et `crypto.getRandomValues` |
| Documentation | améliorée : `get_v1_format_schema` contient un guide (types, expressions, `ctx`) |

## Problèmes restants (à transmettre au développeur)

### P1. Les exemples ne peuvent pas amorcer de données (gênant)
Un exemple de route ne contient que `request` et `response`. Les chemins heureux qui supposent des lignes existantes (PATCH, DELETE, lien de partage, vue publique, liste filtrée, conflit « dernière écriture gagne ») ne sont donc pas testables par `post_v1_drafts_by_id_test`. J'ai contourné avec une route-sonde jetable, ce qui n'est pas satisfaisant.
**Demande :** un champ `given` / `fixtures` dans les exemples (lignes à insérer avant la requête, dans la transaction annulée).

### P2. Pas de verrou ni de condition atomique : concurrence
Le backend d'origine sérialise les écritures d'un utilisateur par verrou consultatif et applique la règle « dernière écriture gagne » dans un seul `INSERT … ON CONFLICT … WHERE updated_at < EXCLUDED.updated_at`. Ici :
- `upsert` n'accepte pas de condition `WHERE` ;
- les routes `PUT /v1/settings`, `POST /v1/sync`, `PATCH`, `DELETE` font **lecture, comparaison, écriture** dans la transaction de la route (niveau READ COMMITTED), donc deux synchronisations simultanées du même utilisateur peuvent s'entrelacer ;
- il n'y a pas d'API de verrou (`pg_advisory_xact_lock`).
**Demande :** `upsert` avec condition de mise à jour (`whereUpdate: updated_at < $new`), ou un verrou par clé (`ctx.db.lock(clé)`).

### P3. Une ligne absente avec `target` donne un 404 avant `respond`
`GET /v1/settings` avec `target` + `scope` renvoie un 404 si la ligne n'existe pas, sans passer par `respond`. Le contrat d'origine est `200 { data: null, updatedAt: null }`. J'ai dû passer par une étape `code` sans `target`.
**Demande :** option pour traiter l'absence comme `$row = null` au lieu d'un 404.

### P4. Format des erreurs différent du backend d'origine
L'outil renvoie du RFC 9457 (`type`, `title`, `status`, `code`). Le backend d'origine renvoie `{ error, message }`, et le client (`src/lib/cloud.js:73`) lit `data.error` et `data.message`. Le client se base sur le statut HTTP, donc rien ne casse, mais les messages utiles en français deviennent « Erreur 404 ». De même, le 409 de conflit d'origine renvoie `current` (la version gagnante) ; ici `ctx.reject` n'accepte que statut, code et message.
**Demande :** gabarit d'erreur configurable, ou `ctx.reject` avec un corps additionnel.

### P5. Écarts de contrat sur les listes déclaratives
`GET /v1/listings` (déclaratif) renvoie `{ items, nextCursor, nextOffset, total }` avec des **lignes de table** (`userId`, `data`, `deleted`, `updatedAt`, `version`…) alors que l'original renvoie des annonces à plat (`{ ...data, id, updatedAt }`). L'extension n'appelle pas cette route (elle passe par `/v1/sync`), mais un autre client serait affecté. Remodeler demande une étape `code`.

### P6. Typage : facultatif ne veut pas dire nullable
`integer?` accepte l'absence mais pas `null` (erreur `response_contract_violation` en sortie et `Champ obligatoire manquant` en entrée). Il faut la forme longue `{ $type: json?, nullable: true }`, présentée comme deux mécanismes distincts. L'extension envoie `settings: null` explicitement. À mieux documenter ou à simplifier.

### P7. Ordre d'évaluation de `map`
`map` est évalué **avant** les étapes : `$pre.at` donne `Variable inconnue à cet endroit : $pre`. Le guide dit que `$<nom>` est disponible « dans steps et respond » mais ne précise pas que `map` en est exclu. Contournement : `patch` ou expression JSONata (`updatedAt ? updatedAt : $millis()`).

### P8. Divers
- `post_v1_drafts` accepte une source YAML invalide (ici un `: ` non quoté dans une expression) sans rien dire ; l'erreur n'apparaît qu'au test. Cela suit la consigne « le texte peut être incomplet », mais un avertissement serait utile.
- Les simulations consomment des valeurs de séquence (`version` avance à chaque test, même annulé). Normal pour PostgreSQL, à connaître.
- `$row` expose les colonnes en camelCase (`updatedAt`), `ctx.db` en snake_case (`updated_at`). Cohérent avec `NAMING=camel`, mais piégeux dans un même fichier.
- L'URL de partage (`https://radar-api.plbls.fr/s/…`) est écrite en dur dans le code ; l'original lit `SHARE_URL_PREFIX`. Une variable de configuration accessible depuis `ctx` serait utile.
- Un `GET` de collection déclaratif ne permet pas de filtrer sur plusieurs valeurs d'enum ni de combiner `OR` ; non nécessaire ici.

## Pas encore fait

- `GET /s/{token}` (page HTML publique de partage, ~100 lignes de gabarit dans `server/src/share.js`). Techniquement possible : `respond.headers: { content-type: "'text/html'" }` et un corps calculé par une étape `code`. Non reproduit.
- `GET /health/ready` (ping base de données).
- Authentification réelle : l'API de gestion ne permet pas de tester `AUTH_VERIFY_URL` ; les tests injectent `user`. À valider après publication avec un vrai jeton.
- Publication : demande d'approbation humaine requise (`post_v1_drafts_by_id_publish`). Rien n'a été publié.
- Parité des chemins avec les données : vérifier après publication que `POST /v1/sync` donne le même résultat que l'API d'origine sur un jeu de test.

---

## Annexe : blocages de la passe 1 (avant évolution de l'outil)

1. Pas de valeur générée par le serveur (`nextval`), donc `version` devait venir du client.
2. Pas d'upsert, erreurs SQL toutes opaques (`db_error`).
3. Une erreur SQL attrapée empoisonnait toute la transaction (aucun savepoint) ; non retesté en passe 2.
4. Pas de mise à jour par expression (fusion JSON, `+ 1`, `GREATEST`).
5. `offset` et options inconnues ignorés sans erreur ; tri sur une colonne.
6. Pas de moyen de vérifier un jeton externe, pas de `fetch`/`crypto`.
7. Réponse 204 impossible sans `target`.
Plus : clé de chemin obligatoire avec `target` (contrainte maintenue, contournée par `scope`), schéma de format contredisant le validateur sur les noms qualifiés (corrigé), types non documentés (corrigé).
