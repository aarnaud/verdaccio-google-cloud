# verdaccio-google-cloud

Google Cloud Storage + Datastore storage plugin for [Verdaccio](https://verdaccio.org).

Uses **Google Cloud Storage** for package tarballs and metadata, and **Cloud Datastore** (default) or **PostgreSQL** for the registry database (package list, secrets, tokens). See [Using PostgreSQL instead of Datastore](#using-postgresql-instead-of-datastore).

Built with Google Cloud SDK for Node.js (`@google-cloud/storage` v7, `@google-cloud/datastore` v10).

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full picture with diagrams: what has to
exist in your Google Cloud project, how the data is laid out in the bucket and in
Datastore, the publish/install/unpublish flows, and the emulator stack used by CI.

## Requirements

- **Node.js** >= 24
- **Verdaccio** >= latest
- **Google Cloud Storage Bucket** — stores package tarballs and `package.json` metadata
- **Cloud Datastore** (default) or **PostgreSQL** >= 11 — stores the registry state (package list, secret, auth tokens)
- **Google Cloud Credentials** — via service account key file, Workload Identity, Application Default Credentials, or environment variables

### IAM Permissions

The plugin requires the following IAM roles or equivalent permissions:

**Cloud Storage:**

- `storage.objects.get`
- `storage.objects.create`
- `storage.objects.delete`
- `storage.objects.list`

**Cloud Datastore:**

- `datastore.entities.get`
- `datastore.entities.create`
- `datastore.entities.update`
- `datastore.entities.delete`
- `datastore.indexes.list`

Recommended roles: `roles/storage.objectAdmin` (for GCS) and `roles/datastore.user` (for Datastore).
With `database: postgres` no Datastore permission is needed at all; the registry state is reached
with PostgreSQL credentials instead.

## Installation

```bash
npm install verdaccio-google-cloud
```

## Configuration

Add to your Verdaccio `config.yaml`:

```yaml
store:
  google-cloud:
    bucket: your-gcs-bucket
    projectId: your-gcp-project-id # optional if using Application Default Credentials
    kind: VerdaccioDataStore # optional, Datastore entity kind (default: VerdaccioDataStore)
    keyFilename: /path/to/service-account.json # optional, for local development
    validation: crc32c # optional, file validation method (default: crc32c)
    resumable: true # optional, enable resumable uploads (default: true)

    # Emulator endpoints (optional, for local development)
    apiEndpoint: http://localhost:5050 # custom GCS endpoint (fake-gcs-server)
    datastoreEndpoint: http://localhost:8081 # custom Datastore endpoint (emulator)
```

### Using PostgreSQL instead of Datastore

Set `database: postgres` to keep the registry state in PostgreSQL (for example Cloud SQL).
Datastore stays the default; with `postgres` selected no Datastore client is created.

```yaml
store:
  google-cloud:
    bucket: GCS_BUCKET
    database: postgres
    postgres:
      # each value is the NAME of an environment variable, or a literal; keep secrets in env vars
      connectionString: DATABASE_URL # or host / port / database / user / password
      ssl: true # true, or {ca: "<PEM>", rejectUnauthorized: true}
      max: 10 # pool size per Verdaccio process (default 10), see sizing note below
      schema: public # schema holding the tables (default public)
      migrate: true # create missing tables at start-up (default true)
      lockTimeoutMs: 30000 # max wait for a per-package lock (default 30000)
```

The native `PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGSSLMODE` variables also work when
the corresponding option is omitted.

- **Tables**: `packages`, `secret`, `tokens`, created on start-up inside `postgres.schema`.
  Replicas starting together are serialised by an advisory lock, so this is safe. The runtime
  user only needs `CREATE` on the schema when a table is missing. To run with a least-privilege
  role, apply [`sql/schema.sql`](sql/schema.sql) once as an admin and, optionally, set
  `migrate: false` (start-up then only verifies the tables exist).
- **Secret**: the registry secret is created once with an atomic insert, so every replica
  ends up with the same one even when they all start against an empty database.
- **No lost publishes across replicas**: every update of a package's metadata takes a
  PostgreSQL advisory lock for that package name, so two replicas publishing different
  versions of one package are serialised instead of the last writer winning. A waiter gives up
  after `lockTimeoutMs` and the request fails with a 5xx; it never proceeds unlocked. A replica
  that dies releases its lock because the lock dies with the database connection.
- **Pool sizing**: a request waiting for a package lock occupies one connection of a second,
  separate pool of the same size, so waiters never starve ordinary queries. A replica can open up
  to `2 * max` connections: keep `replicas * 2 * max` below the server's `max_connections` (with
  Cloud SQL, remember its limits per tier). An update that has not finished after `lockTimeoutMs`
  is abandoned and its lock released.
- **Switching an existing registry from Datastore**: the PostgreSQL tables start empty, so
  the registry secret is regenerated (tokens issued before the switch stop working) and the
  package list is empty until packages are published again. Copy the entries over first if you
  need them.
- **Security**: connections are **plaintext unless you configure TLS** (`ssl`, or `sslmode` in the
  connection string; note node-postgres verifies the certificate for `require`, use
  `sslmode=no-verify` only if you accept that). The `tokens` table stores what Verdaccio hands over, as the Datastore kind does,
  so read access to the database is read access to the registry's auth tokens. Use TLS
  (`ssl`, a private-IP Cloud SQL instance, or the Cloud SQL Auth Proxy), a dedicated role, and
  take the password from a Kubernetes Secret rather than the config file. The connection string
  and password are never written to the debug log.
- **Cloud SQL**: either connect over private IP with `ssl: true`, or run the
  [Cloud SQL Auth Proxy](https://cloud.google.com/sql/docs/postgres/sql-proxy) as a sidecar and
  point `host` at `127.0.0.1` (the proxy encrypts the hop, so `ssl` is not needed there).

For a highly available Kubernetes deployment see [examples/helm/values-postgres.yaml](examples/helm/values-postgres.yaml).

### Environment variable support

The plugin supports configuration via environment variables. If you omit a config field, the plugin checks for the corresponding environment variable:

| Config field  | Environment variable                | Description                      |
| ------------- | ----------------------------------- | -------------------------------- |
| `projectId`   | `GOOGLE_CLOUD_VERDACCIO_PROJECT_ID` | Google Cloud project ID          |
| `keyFilename` | `GOOGLE_CLOUD_VERDACCIO_KEY`        | Path to service account key file |

### Environment variables reference

The following environment variables are used by the Docker image and the plugin:

#### Google Cloud Storage

| Variable               | Required | Description                                                              |
| ---------------------- | -------- | ------------------------------------------------------------------------ |
| `GCS_BUCKET`           | Yes      | GCS bucket name for storing packages                                     |
| `GCS_API_ENDPOINT`     | No       | Custom GCS endpoint URL. Required for fake-gcs-server. Omit for real GCP |
| `GOOGLE_CLOUD_PROJECT` | No       | Google Cloud project ID. Default: from Application Default Credentials   |

#### Cloud Datastore

| Variable                  | Required | Description                                                                            |
| ------------------------- | -------- | -------------------------------------------------------------------------------------- |
| `DATASTORE_EMULATOR_HOST` | No       | Datastore emulator host:port. When set, the SDK automatically connects to the emulator |
| `DATASTORE_ENDPOINT`      | No       | Custom Datastore endpoint URL. Required for the emulator. Omit for real GCP            |

#### Authentication

| Variable                            | Required | Description                                                                        |
| ----------------------------------- | -------- | ---------------------------------------------------------------------------------- |
| `GOOGLE_APPLICATION_CREDENTIALS`    | No       | Path to service account key file. Omit to use Workload Identity or metadata server |
| `GOOGLE_CLOUD_VERDACCIO_PROJECT_ID` | No       | Project ID override for the plugin                                                 |
| `GOOGLE_CLOUD_VERDACCIO_KEY`        | No       | Key file path override for the plugin                                              |

#### Debug

| Variable | Required | Description                                                                                                      |
| -------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `DEBUG`  | No       | Enable [debug](https://www.npmjs.com/package/debug) output. Set to `verdaccio:plugin*` for all plugin namespaces |

Available debug namespaces:

- `verdaccio:plugin:google-cloud` — registry database operations (add, remove, get, tokens, secret)
- `verdaccio:plugin:google-cloud:storage` — GCS package operations (read, write, create, delete, tarballs)

### Custom storage per package scope

```yaml
packages:
  '@scope/*':
    access: $all
    publish: $all
    storage: 'scoped' # stored under scoped/@scope/pkg/
  '**':
    access: $all
    publish: $all
    proxy: npmjs
    storage: 'public'
```

## Architecture

A summary; [ARCHITECTURE.md](ARCHITECTURE.md) has the diagrams and the request flows.

```
                   +-----------+
                   | Verdaccio |
                   +-----+-----+
                         |
            +------------+------------+
            |                         |
   GoogleCloudDatabase      GoogleCloudStorageHandler
   (registry state)         (per-package storage)
            |                         |
       Datastore              Google Cloud Storage
   +-----------------+      +------------------+
   | Secret          |      | pkg/package.json |
   | VerdaccioData.. |      | pkg/tarball.tgz  |
   | Token           |      +------------------+
   +-----------------+
```

**GoogleCloudDatabase** handles registry operations through a backend, Cloud Datastore or PostgreSQL (`database`):

- Package list (`add`, `remove`, `get`)
- Secret management (`getSecret`, `setSecret`)
- Auth tokens (`saveToken`, `deleteToken`, `readTokens`)
- Search (`search`)

**GoogleCloudStorageHandler** handles per-package operations via Google Cloud Storage:

- Package metadata (`readPackage`, `savePackage`, `createPackage`, `deletePackage`)
- Tarballs (`readTarball`, `writeTarball`)

### Datastore entity schema

The plugin uses the following Datastore entity kinds:

| Kind                 | Key                 | Properties                                    | Description         |
| -------------------- | ------------------- | --------------------------------------------- | ------------------- |
| `Secret`             | `secret`            | `secret`                                      | Registry secret key |
| `VerdaccioDataStore` | `{packageName}`     | `name`                                        | Package entry       |
| `Token`              | `{user}:{tokenKey}` | `user`, `key`, `token`, `readonly`, `created` | Auth token          |

The entity kind for packages is configurable via the `kind` config option (default: `VerdaccioDataStore`).

### PostgreSQL schema

| Table      | Key               | Columns                                           | Description         |
| ---------- | ----------------- | ------------------------------------------------- | ------------------- |
| `secret`   | `id` (always 1)   | `value`                                           | Registry secret key |
| `packages` | `name`            | `created_at`                                      | Package entry       |
| `tokens`   | `(username, key)` | `token`, `readonly`, `cidr`, `created`, `updated` | Auth token          |

### Setting up GCP resources (production)

[ARCHITECTURE.md](ARCHITECTURE.md#google-cloud-requirements) explains why each resource is
needed, which permissions map to which operation, and how credentials are resolved.

#### Create a GCS bucket

```bash
gsutil mb -p your-project-id gs://verdaccio-storage
```

#### Enable Cloud Datastore

Skip this when you use `database: postgres`.

Cloud Datastore is automatically available in any GCP project with Firestore in Datastore mode enabled:

```bash
gcloud firestore databases create --type=datastore-mode --location=us-east1
```

#### Terraform

```hcl
resource "google_storage_bucket" "verdaccio" {
  name     = "verdaccio-storage"
  location = "US"
}

resource "google_project_service" "datastore" {
  service = "datastore.googleapis.com"
}
```

## Development

See [LOCAL_DEV.md](LOCAL_DEV.md) for the full local development guide, including:

- Setup, build, test, and lint commands
- Running Verdaccio + GCS/Datastore emulators via Docker Compose
- Inspecting GCS and Datastore data in emulators
- Debug logging namespaces
- Helm + emulators example for Kubernetes

## Scaling & Production Deployment

The plugin keeps no state on the pod and supports horizontal scaling. Run multiple Verdaccio instances behind a load balancer — all instances share the same GCS bucket and the same Datastore or PostgreSQL database.

For high availability on Kubernetes, use `database: postgres`: it removes the Datastore dependency and serialises concurrent publishes of one package across replicas.

**Authentication is not shared by this plugin.** The default `htpasswd` provider writes a file under `/verdaccio/storage`, which is local to each pod, so a user created on one replica cannot log in on another. For more than one replica use an external authentication plugin (LDAP, OIDC, GitHub, ...) or a shared, read-only htpasswd source. Auth tokens issued by Verdaccio are stored in the database and are shared.

- [Helm example, emulators](examples/helm/) — deploy on Kubernetes using the official Verdaccio Helm chart
- [Helm example, HA with PostgreSQL](examples/helm/values-postgres.yaml) — GCS + Cloud SQL / PostgreSQL, Workload Identity, anti-affinity

## License

MIT
