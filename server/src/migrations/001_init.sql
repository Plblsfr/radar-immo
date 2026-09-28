-- Radar Immo : tables de synchronisation.
-- « :schema » est remplacé par le nom du schéma dédié (DB_SCHEMA), déjà validé et échappé.

CREATE TABLE :schema.users (
  id            text PRIMARY KEY,                 -- identifiant fourni par le backend d'authentification
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

-- Numéro de version global : chaque écriture reçoit une valeur croissante,
-- ce qui sert de curseur pour la synchronisation incrémentale.
CREATE SEQUENCE :schema.change_seq;

CREATE TABLE :schema.settings (
  user_id     text PRIMARY KEY REFERENCES :schema.users (id) ON DELETE CASCADE,
  data        jsonb  NOT NULL,
  updated_at  bigint NOT NULL,                    -- horodatage client (ms), arbitre « la dernière écriture gagne »
  version     bigint NOT NULL
);

CREATE TABLE :schema.listings (
  user_id     text   NOT NULL REFERENCES :schema.users (id) ON DELETE CASCADE,
  id          text   NOT NULL,                    -- ex. « leboncoin:2890012345 »
  data        jsonb  NOT NULL DEFAULT '{}'::jsonb,
  deleted     boolean NOT NULL DEFAULT false,     -- tombe : conservée pour propager la suppression
  updated_at  bigint NOT NULL,
  version     bigint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  saved       boolean GENERATED ALWAYS AS (COALESCE((data ->> 'saved')::boolean, false)) STORED,
  status      text    GENERATED ALWAYS AS (data ->> 'status') STORED,
  PRIMARY KEY (user_id, id)
);

CREATE INDEX listings_user_version_idx ON :schema.listings (user_id, version);
CREATE INDEX listings_user_saved_idx   ON :schema.listings (user_id, saved) WHERE NOT deleted;
