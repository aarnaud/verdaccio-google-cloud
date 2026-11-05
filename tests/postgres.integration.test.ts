import PostgresBackend from '../src/backends/postgres';

import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {afterAll, beforeAll, describe, expect, test, vi} from 'vitest';

// Needs a real PostgreSQL >= 11: TEST_POSTGRES_URL=postgres://user:pass@localhost:5432/db pnpm test
const url = process.env.TEST_POSTGRES_URL;

const logger: any = {trace: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn()};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!url)('PostgresBackend against a real database', () => {
  const schema = `verdaccio_it_${randomBytes(4).toString('hex')}`;
  const role = `verdaccio_it_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Pool({connectionString: url, max: 1});
  const backends: PostgresBackend[] = [];

  const create = (overrides: Record<string, unknown> = {}): PostgresBackend => {
    const backend = new PostgresBackend({connectionString: url, schema, ...overrides}, logger);
    backends.push(backend);
    return backend;
  };

  beforeAll(async () => {
    await admin.query('SELECT 1');
  });

  afterAll(async () => {
    await Promise.all(backends.map((b) => b.close()));
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    await admin.end();
  });

  test('replicas starting at once migrate once and agree on one secret', async () => {
    const replicas = Array.from({length: 8}, () => create({max: 2}));

    await Promise.all(replicas.map((r) => r.init()));
    const secrets = await Promise.all(replicas.map((r) => r.getSecret()));

    expect(new Set(secrets).size).toBe(1);
    expect(secrets[0]).toHaveLength(32);
  });

  test('init is idempotent and keeps existing data', async () => {
    const backend = create();
    await backend.init();
    await backend.addPackage('keep-me');
    await create().init();
    expect(await backend.listPackages()).toContain('keep-me');
  });

  test('setSecret never overwrites an existing secret', async () => {
    const backend = create();
    const before = await backend.getSecret();
    await backend.setSecret('x'.repeat(32));
    expect(await backend.getSecret()).toBe(before);
  });

  test('packages: add is idempotent, remove deletes only that name', async () => {
    const backend = create();
    await backend.addPackage('@scope/b');
    await backend.addPackage('@scope/b');
    await backend.addPackage('a-pkg');

    const names = (await backend.listPackages()).filter(
      (n) => n === 'a-pkg' || n.startsWith('@scope/')
    );
    expect([...names].sort()).toEqual(['@scope/b', 'a-pkg']);

    await backend.removePackage('@scope/b');
    expect(await backend.listPackages()).not.toContain('@scope/b');
    expect(await backend.listPackages()).toContain('a-pkg');
  });

  test('tokens round-trip, upsert, filter by user and delete', async () => {
    const backend = create();
    const token = {
      user: 'alice',
      key: 'k1',
      token: 'secret-token',
      readonly: false,
      created: 1730000000000,
      cidr: ['10.0.0.0/8'],
    };
    await backend.saveToken(token);
    await backend.saveToken({
      user: 'bob',
      key: 'k1',
      token: 'bobs',
      readonly: true,
      created: '2026-01-01',
    });

    expect(await backend.readTokens({user: 'alice'} as any)).toEqual([token]);
    expect(await backend.readTokens({user: 'bob'} as any)).toEqual([
      {user: 'bob', key: 'k1', token: 'bobs', readonly: true, created: '2026-01-01'},
    ]);

    await backend.saveToken({...token, readonly: true});
    expect((await backend.readTokens({user: 'alice'} as any))[0].readonly).toBe(true);

    await backend.deleteToken('alice', 'k1');
    expect(await backend.readTokens({user: 'alice'} as any)).toEqual([]);
    expect(await backend.readTokens({user: 'bob'} as any)).toHaveLength(1);
  });

  test('hostile names are stored verbatim', async () => {
    const backend = create();
    const hostile = `x'); DROP TABLE "${schema}".packages; --`;
    await backend.addPackage(hostile);
    expect(await backend.listPackages()).toContain(hostile);
  });

  describe('withPackageLock across replicas', () => {
    test('serialises the same package and parallelises different ones', async () => {
      const a = create();
      const b = create();
      await a.init();

      let running = 0;
      let maxRunning = 0;
      const critical = async (): Promise<void> => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await sleep(100);
        running--;
      };

      await Promise.all([
        a.withPackageLock('same', critical),
        b.withPackageLock('same', critical),
        a.withPackageLock('same', critical),
      ]);
      expect(maxRunning).toBe(1);

      maxRunning = 0;
      await Promise.all([a.withPackageLock('one', critical), b.withPackageLock('two', critical)]);
      expect(maxRunning).toBe(2);
    });

    test('waiters queued on one package do not starve ordinary queries', async () => {
      const backend = create({max: 2, lockTimeoutMs: 5000});
      await backend.init();
      let release!: () => void;
      const holder = backend.withPackageLock('hot', () => new Promise<void>((r) => (release = r)));
      const waiters = [1, 2, 3].map(() => backend.withPackageLock('hot', async () => undefined));
      await sleep(200);

      const started = Date.now();
      await backend.addPackage('during-contention');
      await backend.readTokens({user: 'nobody'} as any);
      expect(Date.now() - started).toBeLessThan(1000);

      release();
      await Promise.all([holder, ...waiters]);
    });

    test('a failing callback still releases the lock', async () => {
      const a = create();
      const b = create();
      await expect(a.withPackageLock('p', () => Promise.reject(new Error('boom')))).rejects.toThrow(
        'boom'
      );
      await expect(b.withPackageLock('p', () => Promise.resolve('ok'))).resolves.toBe('ok');
    });

    test('times out instead of waiting forever, and recovers once the holder is done', async () => {
      const holder = create();
      const waiter = create({lockTimeoutMs: 300});
      let release!: () => void;
      const held = holder.withPackageLock('slow', () => new Promise<void>((r) => (release = r)));
      await sleep(100);

      const started = Date.now();
      await expect(waiter.withPackageLock('slow', async () => 'never')).rejects.toThrow(
        /timed out/
      );
      expect(Date.now() - started).toBeLessThan(5000);

      release();
      await held;
      await expect(waiter.withPackageLock('slow', async () => 'now')).resolves.toBe('now');
    });

    test('a replica whose connection dies while holding the lock frees it', async () => {
      const doomed = create();
      const survivor = create({lockTimeoutMs: 10_000});
      let finish!: () => void;
      const crashing = doomed
        .withPackageLock('crash', () => new Promise<void>((r) => (finish = r)))
        .catch(() => undefined);
      await sleep(100);

      const waiting = survivor.withPackageLock('crash', async () => 'took over');
      await sleep(100);
      await admin.query(
        `SELECT pg_terminate_backend(l.pid) FROM pg_locks l
           JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE l.locktype = 'advisory' AND l.granted AND l.pid <> pg_backend_pid()
            AND a.application_name = 'verdaccio-google-cloud'`
      );

      await expect(waiting).resolves.toBe('took over');
      finish();
      await crashing;
    });
  });

  describe('least-privilege runtime user', () => {
    test('migrate stays on and works when the tables already exist but CREATE is not granted', async () => {
      const rolePassword = randomBytes(8).toString('hex');
      await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${rolePassword}'`);
      await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`
      );
      const u = new URL(url!);
      u.username = role;
      u.password = rolePassword;
      const restricted = new PostgresBackend({connectionString: u.toString(), schema}, logger);
      backends.push(restricted);

      await restricted.init();
      await restricted.addPackage('from-restricted');
      expect(await restricted.listPackages()).toContain('from-restricted');
    });

    test('migrate: false fails fast with a clear error when the schema is missing', async () => {
      const missing = new PostgresBackend(
        {connectionString: url, schema: `nope_${randomBytes(3).toString('hex')}`, migrate: false},
        logger
      );
      backends.push(missing);
      await expect(missing.init()).rejects.toThrow(/does not exist/);
    });
  });
});
