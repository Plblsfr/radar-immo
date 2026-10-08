-- Radar Immo : schéma complet (migrations 001_init + 002_shares consolidées, schéma « radar_immo »).
-- À exécuter une fois, après grants.sql, par le rôle radar_immo (ou un administrateur) :
--   psql "$DATABASE_URL" -f server/sql/schema.sql
-- Pour un autre nom de schéma, remplacer « radar_immo » partout.

CREATE SCHEMA IF NOT EXISTS radar_immo;

CREATE TABLE radar_immo.users (
  id            text PRIMARY KEY,                 -- identifiant fourni par le backend d'authentification
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

-- Numéro de version global : curseur de la synchronisation incrémentale.
CREATE SEQUENCE radar_immo.change_seq;

CREATE TABLE radar_immo.settings (
  user_id     text PRIMARY KEY REFERENCES radar_immo.users (id) ON DELETE CASCADE,
  data        jsonb  NOT NULL,
  updated_at  bigint NOT NULL,                    -- horodatage client (ms), « la dernière écriture gagne »
  version     bigint NOT NULL
);

CREATE TABLE radar_immo.listings (
  user_id     text   NOT NULL REFERENCES radar_immo.users (id) ON DELETE CASCADE,
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

CREATE INDEX listings_user_version_idx ON radar_immo.listings (user_id, version);
CREATE INDEX listings_user_saved_idx   ON radar_immo.listings (user_id, saved) WHERE NOT deleted;

-- Liens de partage publics d'une annonce.
CREATE TABLE radar_immo.shares (
  token          text PRIMARY KEY,                -- secret aléatoire (128 bits, base64url)
  user_id        text NOT NULL REFERENCES radar_immo.users (id) ON DELETE CASCADE,
  listing_id     text NOT NULL,
  message        text,
  include_notes  boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz,                     -- NULL : sans expiration
  revoked_at     timestamptz,
  views          integer NOT NULL DEFAULT 0,
  last_viewed_at timestamptz
);

-- Un seul lien actif par annonce et par utilisateur.
CREATE UNIQUE INDEX shares_active_listing_idx ON radar_immo.shares (user_id, listing_id) WHERE revoked_at IS NULL;
