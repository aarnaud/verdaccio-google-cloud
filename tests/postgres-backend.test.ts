import PostgresBackend, {PackageLockTimeoutError} from '../src/backends/postgres';

import {beforeEach, describe, expect, test, vi} from 'vitest';

const state = vi.hoisted(() => ({
  poolConfig: undefined as any,
  poolErrorHandler: undefined as undefined | ((err: Error) => void),
  query: undefined as any,
  clientQuery: undefined as any,
  release: undefined as any,
  lockPoolConfig: undefined as any,
  poolCount: 0,
  clientListeners: {} as Record<string, any>,
}));

vi.mock('pg', () => {
  class Pool {
    private connectHandlers: Array<(c: any) => void> = [];
    constructor(config: any) {
      if (state.poolCount++ % 2 === 0) state.poolConfig = config;
      else state.lockPoolConfig = config;
    }
    on(event: string, handler: any) {
      if (event === 'error') state.poolErrorHandler = handler;
      if (event === 'connect') this.connectHandlers.push(handler);
    }
    query(...args: any[]) {
      return state.query(...args);
    }
    connect() {
      const client = {
        query: state.clientQuery,
        release: state.release,
        on: (event: string, handler: any) => {
          state.clientListeners[event] = handler;
        },
      };
      this.connectHandlers.forEach((h) => h(client));
      return Promise.resolve(client);
    }
    end() {
      return Promise.resolve();
    }
  }
  const escapeIdentifier = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return {default: {Pool, escapeIdentifier}};
});

const logger: any = {trace: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn()};

describe('PostgresBackend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.query = vi.fn().mockResolvedValue({rows: [], rowCount: 0});
    state.clientQuery = vi.fn().mockResolvedValue({rows: [{pg_advisory_unlock: true}]});
    state.release = vi.fn();
    state.clientListeners = {};
    state.poolCount = 0;
  });

  describe('configuration', () => {
    test.each(['bad-schema', 'a b', '1abc', 'x"; DROP TABLE packages; --', ''])(
      'rejects schema name %j',
      (schema) => {
        expect(() => new PostgresBackend({schema}, logger)).toThrow(/invalid postgres schema/);
      }
    );

    test('rejects a non-positive lock timeout', () => {
      expect(() => new PostgresBackend({lockTimeoutMs: 0}, logger)).toThrow(/lockTimeoutMs/);
      expect(() => new PostgresBackend({lockTimeoutMs: 1.5}, logger)).toThrow(/lockTimeoutMs/);
    });

    test('connectionString wins over discrete fields', () => {
      new PostgresBackend(
        {connectionString: 'postgres://u:p@h/db', host: 'ignored', password: 'ignored'},
        logger
      );
      expect(state.poolConfig.connectionString).toBe('postgres://u:p@h/db');
      expect(state.poolConfig.host).toBeUndefined();
      expect(state.poolConfig.password).toBeUndefined();
    });

    test('passes ssl and pool size through', () => {
      new PostgresBackend({ssl: {ca: 'CA'}, max: 3, host: 'h'}, logger);
      expect(state.poolConfig.ssl).toEqual({ca: 'CA'});
      expect(state.poolConfig.max).toBe(3);
    });

    test('an idle client error is logged and does not throw', () => {
      new PostgresBackend({}, logger);
      expect(() => state.poolErrorHandler!(new Error('terminating connection'))).not.toThrow();
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('queries', () => {
    test('package names are bound as parameters, never interpolated', async () => {
      const backend = new PostgresBackend({}, logger);
      const hostile = `x'; DROP TABLE packages; --`;

      await backend.addPackage(hostile);
      await backend.removePackage(hostile);
      await backend.readTokens({user: hostile});

      for (const [sql, params] of state.query.mock.calls) {
        expect(sql).not.toContain('DROP TABLE');
        expect(params).toContain(hostile);
      }
    });

    test('schema is quoted in every statement', async () => {
      const backend = new PostgresBackend({schema: 'registry'}, logger);
      await backend.listPackages();
      expect(state.query.mock.calls[0][0]).toContain('"registry"."packages"');
    });

    test('getSecret surfaces database errors instead of returning an empty secret', async () => {
      state.query = vi.fn().mockRejectedValue(new Error('connection refused'));
      const backend = new PostgresBackend({}, logger);
      await expect(backend.getSecret()).rejects.toThrow('connection refused');
    });

    test('getSecret creates the secret once and re-reads the winner', async () => {
      state.query = vi
        .fn()
        .mockResolvedValueOnce({rows: []})
        .mockResolvedValueOnce({rowCount: 0})
        .mockResolvedValueOnce({rows: [{value: 'winner-from-other-replica'}]});
      const backend = new PostgresBackend({}, logger);

      expect(await backend.getSecret()).toBe('winner-from-other-replica');
      expect(state.query.mock.calls[1][0]).toContain('ON CONFLICT (id) DO NOTHING');
      expect(state.query.mock.calls[1][1][0]).toHaveLength(32);
    });
  });

  describe('withPackageLock', () => {
    test('locks, runs, unlocks and recycles the connection', async () => {
      const backend = new PostgresBackend({}, logger);
      const result = await backend.withPackageLock('pkg', () => Promise.resolve('done'));

      expect(result).toBe('done');
      const sqls = state.clientQuery.mock.calls.map((c: any[]) => c[0]);
      expect(sqls[0]).toContain('lock_timeout');
      expect(sqls[1]).toContain('pg_advisory_lock');
      expect(sqls[2]).toContain('pg_advisory_unlock');
      expect(sqls[3]).toContain('RESET lock_timeout');
      expect(state.release).toHaveBeenCalledWith(undefined);
    });

    test('a connection error while the lock is held is logged, not thrown', async () => {
      const backend = new PostgresBackend({}, logger);
      await backend.withPackageLock('pkg', async () => {
        expect(() => state.clientListeners.error(new Error('terminated'))).not.toThrow();
      });
      expect(logger.error).toHaveBeenCalled();
    });

    test('locks use their own pool, so waiters cannot starve ordinary queries', () => {
      new PostgresBackend({max: 4, lockTimeoutMs: 5000}, logger);
      expect(state.poolConfig.max).toBe(4);
      expect(state.poolConfig.connectionTimeoutMillis).toBe(10_000);
      expect(state.lockPoolConfig.max).toBe(4);
      expect(state.lockPoolConfig.connectionTimeoutMillis).toBe(5000);
    });

    test('a callback that never settles gives up and still releases the lock', async () => {
      const backend = new PostgresBackend({lockTimeoutMs: 50}, logger);
      await expect(
        backend.withPackageLock('pkg', () => new Promise<void>(() => undefined))
      ).rejects.toThrow(/did not finish within 50ms/);
      const sqls = state.clientQuery.mock.calls.map((c: any[]) => c[0]);
      expect(sqls.some((s: string) => s.includes('pg_advisory_unlock'))).toBe(true);
      expect(state.release).toHaveBeenCalledTimes(1);
    });

    test('unlocks even when the callback throws', async () => {
      const backend = new PostgresBackend({}, logger);
      await expect(
        backend.withPackageLock('pkg', () => Promise.reject(new Error('boom')))
      ).rejects.toThrow('boom');

      const sqls = state.clientQuery.mock.calls.map((c: any[]) => c[0]);
      expect(sqls.some((s: string) => s.includes('pg_advisory_unlock'))).toBe(true);
    });

    test('destroys the connection when unlocking fails, which drops the lock server-side', async () => {
      state.clientQuery = vi
        .fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('socket closed'));
      const backend = new PostgresBackend({}, logger);

      await backend.withPackageLock('pkg', () => Promise.resolve());

      expect(state.release).toHaveBeenCalledTimes(1);
      expect(state.release.mock.calls[0][0]).toBeInstanceOf(Error);
    });

    test('destroys the connection when the lock was not actually held', async () => {
      state.clientQuery = vi.fn().mockResolvedValue({rows: [{pg_advisory_unlock: false}]});
      const backend = new PostgresBackend({}, logger);
      await backend.withPackageLock('pkg', () => Promise.resolve());
      expect(state.release).toHaveBeenCalledWith(true);
    });

    test('maps a lock timeout to PackageLockTimeoutError and never runs the callback', async () => {
      const timeout = Object.assign(new Error('canceling statement due to lock timeout'), {
        code: '55P03',
      });
      state.clientQuery = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(timeout);
      const backend = new PostgresBackend({}, logger);
      const fn = vi.fn();

      await expect(backend.withPackageLock('pkg', fn)).rejects.toBeInstanceOf(
        PackageLockTimeoutError
      );
      expect(fn).not.toHaveBeenCalled();
      expect(state.release.mock.calls[0][0]).toBe(timeout);
    });
  });
});
