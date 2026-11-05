import type {Logger, Token, TokenFilter} from '@verdaccio/types';

import type {PostgresConfig} from '../../types';
import type {RegistryBackend} from './types';

import debugCore from 'debug';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import type {Pool, PoolClient, PoolConfig} from 'pg';

const debug = debugCore('verdaccio:plugin:google-cloud:postgres');

export const DEFAULT_SCHEMA = 'public';
export const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_POOL_SIZE = 10;
const CONNECTION_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 30_000;
// pg_advisory_lock waits are subject to statement_timeout too, so it has to outlast lock_timeout
const STATEMENT_TIMEOUT_HEADROOM_MS = 30_000;

const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export class PackageLockTimeoutError extends Error {
  public constructor(name: string, timeoutMs: number, held = false) {
    super(
      held
        ? `update of ${name} did not finish within ${timeoutMs}ms`
        : `timed out after ${timeoutMs}ms waiting for another instance to finish updating ${name}`
    );
    this.name = 'PackageLockTimeoutError';
  }
}

export default class PostgresBackend implements RegistryBackend {
  private readonly pool: Pool;
  // package-lock waiters sit on a connection for up to lockTimeoutMs; on the data pool they would
  // starve every ordinary query (tokens, search, secret) as soon as `max` publishes queue on one package
  private readonly lockPool: Pool;
  private closing?: Promise<void>;
  private readonly schema: string;
  private readonly migrate: boolean;
  private readonly lockTimeoutMs: number;
  private readonly t: {packages: string; secret: string; tokens: string};

  public constructor(
    config: PostgresConfig,
    private readonly logger: Logger
  ) {
    const schema = config.schema ?? DEFAULT_SCHEMA;
    if (!SCHEMA_NAME.test(schema)) {
      throw new Error(`google-cloud: invalid postgres schema name ${JSON.stringify(schema)}`);
    }
    this.schema = schema;
    this.migrate = config.migrate !== false;
    this.lockTimeoutMs = config.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    if (!Number.isInteger(this.lockTimeoutMs) || this.lockTimeoutMs <= 0) {
      throw new Error('google-cloud: postgres.lockTimeoutMs must be a positive integer');
    }

    const q = pg.escapeIdentifier(schema);
    this.t = {
      packages: `${q}.${pg.escapeIdentifier('packages')}`,
      secret: `${q}.${pg.escapeIdentifier('secret')}`,
      tokens: `${q}.${pg.escapeIdentifier('tokens')}`,
    };

    const poolConfig: PoolConfig = {
      max: config.max ?? DEFAULT_POOL_SIZE,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      statement_timeout: this.lockTimeoutMs + STATEMENT_TIMEOUT_HEADROOM_MS,
      application_name: 'verdaccio-google-cloud',
      keepAlive: true,
    };
    if (config.connectionString) {
      poolConfig.connectionString = config.connectionString;
    } else {
      poolConfig.host = config.host;
      poolConfig.port = config.port;
      poolConfig.database = config.database;
      poolConfig.user = config.user;
      poolConfig.password = config.password;
    }
    if (config.ssl !== undefined) {
      poolConfig.ssl = config.ssl;
    }

    this.pool = this.createPool(poolConfig);
    // queued lockers may legitimately wait as long as the lock itself
    this.lockPool = this.createPool({...poolConfig, connectionTimeoutMillis: this.lockTimeoutMs});

    debug(
      'configured host=%o database=%o schema=%o max=%d',
      config.host,
      config.database,
      schema,
      poolConfig.max
    );
  }

  private createPool(poolConfig: PoolConfig): Pool {
    const pool = new pg.Pool(poolConfig);
    // an idle client dropped by the server (failover, restart) emits 'error'; unhandled it would
    // take the whole process down
    pool.on('error', (err: Error): void => {
      debug('idle client error: %o', err);
      this.logger.error({err: err.message}, 'google-cloud: [postgres] idle client error: @{err}');
    });
    pool.on('connect', (client: PoolClient): void => {
      client.on('error', this.onClientError);
    });
    return pool;
  }

  public async init(): Promise<void> {
    if (this.migrate) {
      await this.runMigration();
    } else {
      // fail at startup with a clear message rather than on the first request
      await this.pool.query(`SELECT 1 FROM ${this.t.packages} LIMIT 1`);
      await this.pool.query(`SELECT 1 FROM ${this.t.secret} LIMIT 1`);
      await this.pool.query(`SELECT 1 FROM ${this.t.tokens} LIMIT 1`);
    }
    await this.getSecret();
  }

  public async getSecret(): Promise<string> {
    // Verdaccio calls getSecret() and, when empty, generates its own secret and keeps that one in
    // memory. Replicas starting together against an empty database would each pick a different
    // secret and reject each other's tokens, so the first one to get here creates it for everyone.
    // Errors are deliberately not swallowed: an empty answer on a transient failure would make
    // this instance diverge from the rest.
    const existing = await this.readSecret();
    if (existing !== undefined) {
      return existing;
    }
    const candidate = randomBytes(32).toString('base64').substring(0, 32);
    await this.pool.query(
      `INSERT INTO ${this.t.secret} (id, value) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`,
      [candidate]
    );
    const stored = await this.readSecret();
    if (stored === undefined) {
      throw new Error('google-cloud: [postgres] secret row missing right after insert');
    }
    return stored;
  }

  public async setSecret(secret: string): Promise<void> {
    // first writer wins; never overwrite a secret other replicas are already signing tokens with
    const result = await this.pool.query(
      `INSERT INTO ${this.t.secret} (id, value) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`,
      [secret]
    );
    if (result.rowCount === 0 && (await this.readSecret()) !== secret) {
      this.logger.warn('google-cloud: [postgres] a different secret is already stored, keeping it');
    }
  }

  public async addPackage(name: string): Promise<void> {
    debug('add package=%o', name);
    await this.pool.query(
      `INSERT INTO ${this.t.packages} (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
      [name]
    );
  }

  public async removePackage(name: string): Promise<void> {
    debug('remove package=%o', name);
    await this.pool.query(`DELETE FROM ${this.t.packages} WHERE name = $1`, [name]);
  }

  public async listPackages(): Promise<string[]> {
    const result = await this.pool.query<{name: string}>(
      `SELECT name FROM ${this.t.packages} ORDER BY name`
    );
    debug('list packages count=%d', result.rowCount);
    return result.rows.map((row): string => row.name);
  }

  public async saveToken(token: Token): Promise<void> {
    debug('saveToken user=%o key=%o', token.user, token.key);
    await this.pool.query(
      `INSERT INTO ${this.t.tokens} (username, key, token, readonly, cidr, created, updated)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
       ON CONFLICT (username, key) DO UPDATE SET
         token = EXCLUDED.token,
         readonly = EXCLUDED.readonly,
         cidr = EXCLUDED.cidr,
         created = EXCLUDED.created,
         updated = EXCLUDED.updated`,
      [
        token.user,
        token.key,
        token.token,
        token.readonly,
        token.cidr ?? null,
        JSON.stringify(token.created ?? null),
        JSON.stringify(token.updated ?? null),
      ]
    );
  }

  public async deleteToken(user: string, tokenKey: string): Promise<void> {
    debug('deleteToken user=%o key=%o', user, tokenKey);
    await this.pool.query(`DELETE FROM ${this.t.tokens} WHERE username = $1 AND key = $2`, [
      user,
      tokenKey,
    ]);
  }

  public async readTokens(filter: TokenFilter): Promise<Token[]> {
    debug('readTokens user=%o', filter.user);
    const result = await this.pool.query(
      `SELECT username, key, token, readonly, cidr, created, updated
         FROM ${this.t.tokens} WHERE username = $1 ORDER BY key`,
      [filter.user]
    );
    return result.rows.map((row): Token => {
      const token: Token = {
        user: row.username,
        key: row.key,
        token: row.token,
        readonly: row.readonly,
        created: row.created,
      };
      if (row.cidr) {
        token.cidr = row.cidr;
      }
      if (row.updated !== null) {
        token.updated = row.updated;
      }
      return token;
    });
  }

  public async withPackageLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const lockKey = `${this.schema}:package:${name}`;
    const client = await this.checkout(this.lockPool);
    try {
      // lock_timeout covers advisory lock waits; without it a stuck holder blocks everyone forever
      await client.query(`SELECT set_config('lock_timeout', $1, false)`, [
        `${this.lockTimeoutMs}ms`,
      ]);
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey]);
    } catch (err: any) {
      // destroy rather than recycle: the session may still be mid-wait or hold the lock
      this.giveBack(client, err);
      if (err?.code === '55P03') {
        this.logger.error({name}, 'google-cloud: [postgres] lock timeout on package @{name}');
        throw new PackageLockTimeoutError(name, this.lockTimeoutMs);
      }
      throw err;
    }
    debug('lock acquired package=%o', name);

    // fn must never touch this.pool/lockPool connections beyond this client, and must finish: a
    // holder that never settles (a callback that is never invoked) would otherwise pin the lock
    // and its connection until the process dies, blocking every replica on this package
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject): void => {
          timer = setTimeout((): void => {
            reject(new PackageLockTimeoutError(name, this.lockTimeoutMs, true));
          }, this.lockTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      await this.releaseLock(client, lockKey, name);
    }
  }

  // pg-pool only listens for errors on idle clients; a checked-out connection killed by the
  // server (failover, maintenance) would otherwise surface as an uncaught exception.
  // (the listener is attached once per physical connection in createPool)
  private checkout(pool: Pool = this.pool): Promise<PoolClient> {
    return pool.connect();
  }

  private giveBack(client: PoolClient, err?: Error | boolean): void {
    client.release(err);
  }

  private readonly onClientError = (err: Error): void => {
    this.logger.error({err: err.message}, 'google-cloud: [postgres] client error: @{err}');
  };

  public async close(): Promise<void> {
    if (!this.closing) {
      this.closing = Promise.all([this.pool.end(), this.lockPool.end()]).then(
        (): void => undefined
      );
    }
    await this.closing;
  }

  private async releaseLock(client: PoolClient, lockKey: string, name: string): Promise<void> {
    try {
      const result = await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
        lockKey,
      ]);
      await client.query('RESET lock_timeout');
      // false = the session did not hold the lock; do not hand such a connection back
      this.giveBack(client, result.rows[0]?.pg_advisory_unlock === true ? undefined : true);
      debug('lock released package=%o', name);
    } catch (err: any) {
      // closing the connection drops every session-level lock it holds
      this.giveBack(client, err);
      this.logger.warn(
        {name, err: err?.message},
        'google-cloud: [postgres] could not release lock on @{name} cleanly, connection dropped: @{err}'
      );
    }
  }

  private async readSecret(): Promise<string | undefined> {
    const result = await this.pool.query<{value: string}>(
      `SELECT value FROM ${this.t.secret} WHERE id = 1`
    );
    return result.rows[0]?.value;
  }

  private async runMigration(): Promise<void> {
    const client = await this.checkout();
    try {
      await client.query('BEGIN');
      // serialise replicas starting together; released automatically at COMMIT/ROLLBACK
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${this.schema}:migrate`,
      ]);

      // CREATE ... IF NOT EXISTS still demands CREATE privilege on the schema even when the
      // object exists, so only issue DDL for what is really missing: a least-privilege runtime
      // user against a pre-provisioned database must keep working with migrate left on
      const existing = await client.query<{packages: boolean; secret: boolean; tokens: boolean}>(
        `SELECT to_regclass($1) IS NOT NULL AS packages,
                to_regclass($2) IS NOT NULL AS secret,
                to_regclass($3) IS NOT NULL AS tokens`,
        [this.t.packages, this.t.secret, this.t.tokens]
      );
      const have = existing.rows[0];

      if (this.schema !== DEFAULT_SCHEMA) {
        const schemaExists = await client.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [
          this.schema,
        ]);
        if (schemaExists.rowCount === 0) {
          await client.query(`CREATE SCHEMA ${pg.escapeIdentifier(this.schema)}`);
        }
      }
      if (!have.packages) {
        await client.query(
          `CREATE TABLE ${this.t.packages} (
             name text PRIMARY KEY,
             created_at timestamptz NOT NULL DEFAULT now()
           )`
        );
      }
      if (!have.secret) {
        await client.query(
          `CREATE TABLE ${this.t.secret} (
             id smallint PRIMARY KEY CHECK (id = 1),
             value text NOT NULL
           )`
        );
      }
      if (!have.tokens) {
        await client.query(
          `CREATE TABLE ${this.t.tokens} (
             username text NOT NULL,
             key text NOT NULL,
             token text NOT NULL,
             readonly boolean NOT NULL DEFAULT false,
             cidr text[],
             created jsonb,
             updated jsonb,
             PRIMARY KEY (username, key)
           )`
        );
      }
      await client.query('COMMIT');
      debug('migration done');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // the original error is the one worth reporting
      }
      this.giveBack(client, err as Error);
      throw err;
    }
    this.giveBack(client);
  }
}
