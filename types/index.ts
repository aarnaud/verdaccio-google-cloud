import type {Config} from '@verdaccio/types';

export interface PostgresConfig {
  /** Full connection string; takes precedence over the discrete host/port/user/password/database fields. */
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  /** `true`, or node-postgres TLS options (e.g. `{ca: '...'}`) */
  ssl?: boolean | {ca?: string; rejectUnauthorized?: boolean};
  /** Maximum pool size (default: 10) */
  max?: number;
  /** Schema holding the registry tables (default: `public`) */
  schema?: string;
  /** Create the tables on startup when missing (default: true) */
  migrate?: boolean;
  /** How long to wait for another replica's per-package lock, in ms (default: 30000) */
  lockTimeoutMs?: number;
}

export type DatabaseBackend = 'datastore' | 'postgres';

export interface GoogleCloudConfig extends Config {
  bucket: string;
  projectId?: string;
  kind?: string;
  keyFilename?: string;
  validation?: GoogleValidation;
  resumable?: boolean;
  apiEndpoint?: string;
  datastoreEndpoint?: string;
  /** Where registry state (package list, secret, tokens) lives (default: `datastore`) */
  database?: DatabaseBackend;
  postgres?: PostgresConfig;
}

export type GoogleValidation = boolean | string;
