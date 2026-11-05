import DatastoreBackend from '../src/backends/datastore';

import {describe, expect, test, vi} from 'vitest';

const KEY = Symbol('KEY');

const logger: any = {trace: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn()};

const createDatastore = (rows: object[]): any => ({
  KEY,
  key: (path: string[]) => ({path}),
  createQuery: (kind: string) => ({kind}),
  runQuery: () => Promise.resolve([rows, {}]),
  delete: vi.fn().mockResolvedValue(undefined),
});

describe('DatastoreBackend', () => {
  // Regression: packages are stored under a NAME key, so the key carries `name` and
  // `id` is undefined. Rebuilding the key from an id threw and made unpublish impossible.
  test('removePackage deletes with the key it read, not one rebuilt from an id', async () => {
    const nameKey = {kind: 'Package', name: '@scope/pkg'};
    const datastore = createDatastore([
      {name: '@scope/pkg', [KEY]: nameKey},
      {name: 'other', [KEY]: {kind: 'Package', name: 'other'}},
    ]);
    const backend = new DatastoreBackend(datastore, 'Package', logger);

    await backend.removePackage('@scope/pkg');

    expect(datastore.delete).toHaveBeenCalledTimes(1);
    expect(datastore.delete).toHaveBeenCalledWith(nameKey);
  });

  test('removePackage ignores rows without a name', async () => {
    const datastore = createDatastore([{[KEY]: {kind: 'Package', name: 'x'}}]);
    const backend = new DatastoreBackend(datastore, 'Package', logger);

    await backend.removePackage('x');

    expect(datastore.delete).not.toHaveBeenCalled();
  });

  test('listPackages returns the stored names', async () => {
    const datastore = createDatastore([{name: 'a'}, {name: 'b'}]);
    const backend = new DatastoreBackend(datastore, 'Package', logger);

    expect(await backend.listPackages()).toEqual(['a', 'b']);
  });
});
