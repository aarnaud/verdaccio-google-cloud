---
'verdaccio-google-cloud': minor
---

Add an optional PostgreSQL registry-state backend (`database: postgres`) as an alternative to Cloud Datastore, so Verdaccio can run highly available on Kubernetes with GCS for bytes and PostgreSQL (for example Cloud SQL) for the package list, secret and tokens. The Postgres backend also takes a per-package advisory lock around metadata updates, so concurrent publishes on different replicas no longer overwrite each other. Datastore remains the default and is unchanged.
