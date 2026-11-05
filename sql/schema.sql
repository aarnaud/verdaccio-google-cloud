-- Registry state for the verdaccio-google-cloud `database: postgres` backend.
-- The plugin creates this itself on start-up (postgres.migrate defaults to true). Apply this file
-- by hand, as a privileged role, only when you run the plugin with `migrate: false`.
-- Requires PostgreSQL 11 or newer. Replace "public" if you configure postgres.schema.

CREATE TABLE IF NOT EXISTS public.packages (
  name text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.secret (
  id smallint PRIMARY KEY CHECK (id = 1),
  value text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.tokens (
  username text NOT NULL,
  key text NOT NULL,
  token text NOT NULL,
  readonly boolean NOT NULL DEFAULT false,
  cidr text[],
  created jsonb,
  updated jsonb,
  PRIMARY KEY (username, key)
);

-- Runtime role (least privilege): no DDL needed once the tables exist.
-- GRANT USAGE ON SCHEMA public TO verdaccio;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON public.packages, public.secret, public.tokens TO verdaccio;
