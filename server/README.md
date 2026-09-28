# API Radar Immo

Backend de Radar Immo. Il garde les **critères** et les **annonces suivies** de chaque utilisateur et les synchronise entre l'extension (sur tous ses navigateurs) et l'application web.

- **Authentification déléguée** : l'API ne gère ni comptes ni mots de passe. Elle transmet le jeton reçu au backend d'authentification existant.
- **Base partagée, schéma dédié** : l'API utilise le même PostgreSQL que le backend principal, mais toutes ses tables sont dans un schéma à part (`radar_immo` par défaut). Elle ne lit ni n'écrit aucune table du backend principal.
- Node.js 20+, [Fastify](https://fastify.dev), [pg](https://node-postgres.com). Trois dépendances en tout.

```
Extension ─┐                                     ┌─► Backend d'authentification
           ├─ Authorization: Bearer <jeton> ─► API Radar Immo ── GET AUTH_VERIFY_URL (jeton en en-tête)
Front-end ─┘                                     └─► PostgreSQL, schéma « radar_immo »
```

## Démarrage rapide

```bash
cd server
cp .env.example .env        # puis renseigne DATABASE_URL et AUTH_VERIFY_URL
npm install
npm run migrate             # facultatif : les migrations passent aussi au démarrage
npm start                   # http://localhost:3000/health
```

Avec Docker :

```bash
docker build -t radar-immo-api server/
docker run --env-file server/.env -p 3000:3000 radar-immo-api
```

## Base de données

Le backend s'installe à côté du backend principal, sur la même base, sans rien toucher à ses tables.

1. **Crée un rôle dédié et son schéma** (une fois, par un administrateur de la base) : [`sql/grants.sql`](sql/grants.sql). Le rôle `radar_immo` est propriétaire de son seul schéma et n'a aucun droit sur les autres.
2. **Renseigne** `DATABASE_URL` avec ce rôle et `DB_SCHEMA=radar_immo`.
3. **Les migrations** (`src/migrations/*.sql`) sont appliquées au démarrage (`MIGRATE_ON_START=true`) ou avec `npm run migrate`. Elles sont idempotentes et protégées par un verrou : plusieurs instances peuvent démarrer en même temps. L'état est suivi dans `radar_immo.schema_migrations`.

Toutes les requêtes utilisent des noms qualifiés (`"radar_immo"."listings"`), sans `search_path` : l'API fonctionne derrière PgBouncer en mode transaction.

| Table | Contenu |
|---|---|
| `users` | Un identifiant par utilisateur, fourni par le backend d'authentification. Pas de donnée personnelle. |
| `settings` | Les critères de l'utilisateur (objet JSON de l'extension). |
| `listings` | Une ligne par annonce suivie (JSON), plus les « tombes » des annonces supprimées, qui propagent la suppression aux autres appareils. |

## Authentification

À chaque requête sur `/v1/*`, l'API lit `Authorization: Bearer <jeton>`, puis appelle :

```
GET {AUTH_VERIFY_URL}
{AUTH_HEADER_NAME}: {AUTH_HEADER_PREFIX}<jeton>        (par défaut : Authorization: Bearer <jeton>)
```

| Réponse du backend d'authentification | Réponse de l'API au client |
|---|---|
| **2xx** | La requête continue. |
| **403** | `403 forbidden` |
| **Autre 4xx** (401, 404…) | `401 invalid_token` |
| **5xx**, délai dépassé (`AUTH_TIMEOUT_MS`), réseau | `503 auth_unavailable` |
| 2xx sans identifiant exploitable | `502 auth_no_user_id` (erreur de configuration) |

**Identifiant de l'utilisateur.** L'API a besoin d'un identifiant stable pour ranger les données. Elle le cherche, dans l'ordre, dans le corps JSON de la réponse 2xx aux chemins de `AUTH_USER_ID_PATHS` (par défaut `id`, `userId`, `user_id`, `sub`, `user.id`, `data.id`), puis dans le claim `sub` du jeton s'il s'agit d'un JWT. **La route de vérification doit donc renvoyer l'identifiant**, ou le jeton doit être un JWT avec `sub`. Adapte `AUTH_USER_ID_PATHS` au format réel.

**Cache.** Un jeton validé n'est pas revérifié pendant `AUTH_CACHE_TTL_MS` (30 s par défaut). Un refus est mémorisé 5 s au plus, une panne jamais. Le cache est indexé par l'empreinte SHA-256 du jeton : les jetons ne sont ni stockés ni journalisés.

## API

Toutes les routes `/v1/*` exigent `Authorization: Bearer <jeton>`. Les erreurs ont la forme `{ "error": "code", "message": "texte" }`.

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/health` | Vivant (sans authentification) |
| GET | `/health/ready` | Vivant et base joignable (sans authentification) |
| GET | `/v1/me` | `{ userId }` |
| GET | `/v1/settings` | Critères : `{ data, updatedAt }` (`null` si jamais enregistrés) |
| PUT | `/v1/settings` | Remplace les critères : `{ data, updatedAt? }`. `409` si `updatedAt` est plus ancien que la version stockée. |
| GET | `/v1/listings` | Liste paginée : `?saved=true&status=visit&limit=50&offset=0` → `{ items, total }` |
| GET | `/v1/listings/:id` | Une annonce (id encodé, ex. `leboncoin%3A2890012345`) |
| PATCH | `/v1/listings/:id` | Suivi : `status`, `notes`, `saved`, `checklist`, `overrides` |
| DELETE | `/v1/listings/:id` | Supprime l'annonce (et sur les autres appareils) |
| POST | `/v1/sync` | Synchronisation incrémentale de l'extension |
| GET | `/v1/export` | Toutes les données de l'utilisateur |
| DELETE | `/v1/data` | Efface toutes les données de l'utilisateur, partout |

Le détail des formats, pensé pour l'équipe front-end, est dans le [cahier des charges front-end](../docs/CDC-front-end.md).

### Synchronisation

`POST /v1/sync` reçoit les changements d'un appareil et renvoie ceux qu'il n'a pas encore vus :

```jsonc
// requête
{ "since": 1520,                                     // curseur de la synchro précédente (0 la première fois)
  "settings": { "data": { … }, "updatedAt": 1790590084168 },   // facultatif
  "listings": [
    { "id": "leboncoin:123", "updatedAt": 1790590084168, "data": { … } },
    { "id": "pap:456", "updatedAt": 1790590090000, "deleted": true }
  ] }
// réponse
{ "cursor": 1534, "hasMore": false,
  "settings": null,                                  // présent seulement s'il a changé depuis « since »
  "listings": [ { "id": "…", "updatedAt": …, "deleted": false, "data": { … } } ],
  "applied": { "settings": true, "listings": 2, "ignored": 0 } }
```

- **La dernière écriture gagne** : un enregistrement n'est remplacé que si son `updatedAt` (ms) est plus récent. Les horodatages trop dans le futur sont ramenés à « maintenant + 5 min ».
- Le **curseur** est un numéro de version croissant. Les écritures d'un même utilisateur sont sérialisées par un verrou consultatif PostgreSQL, ce qui garantit que le curseur ne saute aucun changement.
- `hasMore: true` : rappeler avec `since = cursor` jusqu'à `false`.
- Limites : 500 annonces poussées et 500 renvoyées par appel, 64 Ko par annonce, 256 Ko de critères, 5 Mo par requête (configurables).

### CORS

Autorisés : les origines listées dans `CORS_ORIGINS` (le front-end) et, si `CORS_ALLOW_EXTENSIONS=true`, les extensions (`chrome-extension://…`, `moz-extension://…`). `CORS_EXTENSION_IDS` restreint les extensions Chrome aux identifiants publiés. Les identifiants Firefox changent à chaque installation et ne peuvent pas être listés.

## Configuration

Toutes les variables sont décrites dans [`.env.example`](.env.example). Obligatoires : `DATABASE_URL` et `AUTH_VERIFY_URL`.

## Tests

```bash
npm test                                                  # tests sans base (authentification)
TEST_DATABASE_URL=postgres://postgres@localhost:5432/radar_test npm test   # + API complète
```

Les tests d'API créent un schéma temporaire, simulent le backend d'authentification avec un petit serveur HTTP local, puis suppriment le schéma. La CI les lance sur un PostgreSQL 16.

## Exploitation

- **Journaux** : JSON (pino), en-tête `Authorization` masqué.
- **Sondes** : `/health` (vivant) et `/health/ready` (base joignable).
- **Arrêt propre** sur `SIGTERM` / `SIGINT`.
- **Derrière un reverse proxy** : `TRUST_PROXY=true`. Termine TLS au proxy : l'extension et le front-end exigent HTTPS.
- **Limitation de débit** : non incluse, à faire au niveau du proxy ou de la passerelle si besoin.
