-- Liens de partage publics d'une annonce.
-- Le lien affiche l'état courant de l'annonce (prix à jour…), filtré aux champs publics.

CREATE TABLE :schema.shares (
  token          text PRIMARY KEY,                 -- secret aléatoire (128 bits, base64url)
  user_id        text NOT NULL REFERENCES :schema.users (id) ON DELETE CASCADE,
  listing_id     text NOT NULL,
  message        text,                             -- mot du propriétaire, affiché sur la page
  include_notes  boolean NOT NULL DEFAULT false,   -- montrer aussi ses notes personnelles
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz,                      -- NULL : sans expiration
  revoked_at     timestamptz,
  views          integer NOT NULL DEFAULT 0,
  last_viewed_at timestamptz
);

-- Un seul lien actif par annonce et par utilisateur.
CREATE UNIQUE INDEX shares_active_listing_idx ON :schema.shares (user_id, listing_id) WHERE revoked_at IS NULL;
