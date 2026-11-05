import {errorUtils} from '@verdaccio/core';
import type {searchUtils} from '@verdaccio/core';
import type {Callback, Config, Logger, Token, TokenFilter} from '@verdaccio/types';

import type {GoogleCloudConfig, PostgresConfig} from '../types';
import DatastoreBackend, {DEFAULT_KIND} from './backends/datastore';
import PostgresBackend from './backends/postgres';
import type {PackageLocker, RegistryBackend} from './backends/types';
import setConfigValue from './setConfigValue';
import GoogleCloudStorageHandler from './storage';
import type {IStorageHelper} from './storage-helper';
import StorageHelper from './storage-helper';

import type {DatastoreOptions} from '@google-cloud/datastore';
import {Datastore} from '@google-cloud/datastore';
import type {StorageOptions} from '@google-cloud/storage';
import {Storage} from '@google-cloud/storage';
import debugCore from 'debug';

const debug = debugCore('verdaccio:plugin:google-cloud');

// backend errors can carry hosts and role names; clients get this, the log gets the details
const DATABASE_ERROR = 'registry database error';

export const ERROR_MISSING_CONFIG =
  'google cloud storage missing config. Add `store.google-cloud` to your config file';

export default class GoogleCloudDatabase {
  private helper: IStorageHelper;
  private backend: RegistryBackend;
  public logger: Logger;
  public config: GoogleCloudConfig;
  private kind: string;
  private bucketName: string;

  public constructor(config: Config, options: {logger: Logger; config: Config}) {
    if (!config) {
      throw new Error(ERROR_MISSING_CONFIG);
    }

    this.logger = options.logger;

    // verdaccio 7+ passes plugin config directly, older versions nest it under config.store
    const pluginConfig = config.store?.['google-cloud'] ?? {};
    this.config = Object.assign({}, config, pluginConfig) as GoogleCloudConfig;

    // Resolve config values from environment variables
    this.config.bucket = setConfigValue(this.config.bucket);
    this.config.projectId = setConfigValue(this.config.projectId);
    this.config.keyFilename = setConfigValue(this.config.keyFilename);
    this.config.apiEndpoint = setConfigValue(this.config.apiEndpoint);
    this.config.datastoreEndpoint = setConfigValue(this.config.datastoreEndpoint);

    this.kind = this.config.kind || DEFAULT_KIND;

    if (!this.config.bucket) {
      throw new Error('Google Cloud Storage requires a bucket name, please define one.');
    }
    this.bucketName = this.config.bucket;

    this.helper = new StorageHelper(new Storage(this._getStorageOptions()), this.config);
    this.backend = this._createBackend();

    const database = this.config.database ?? 'datastore';
    debug(
      'initialized bucket=%o projectId=%o database=%o kind=%o',
      this.bucketName,
      this.config.projectId,
      database,
      this.kind
    );
    this.logger.trace(
      {bucket: this.bucketName, projectId: this.config.projectId, database, kind: this.kind},
      'google-cloud: plugin initialized bucket=@{bucket} projectId=@{projectId} database=@{database} kind=@{kind}'
    );
  }

  public async init(): Promise<void> {
    debug('init: verifying connectivity');
    this.logger.trace('google-cloud: [init] verifying connectivity');
    await this.backend.init();
    debug('init: connectivity verified');
    this.logger.trace('google-cloud: [init] connectivity verified');
  }

  public async close(): Promise<void> {
    await this.backend.close?.();
  }

  private _createBackend(): RegistryBackend {
    const database = this.config.database ?? 'datastore';
    switch (database) {
      case 'datastore':
        return new DatastoreBackend(
          new Datastore(this._getGoogleOptions()),
          this.kind,
          this.logger
        );
      case 'postgres':
        return new PostgresBackend(this._resolvePostgresConfig(), this.logger);
      default:
        throw new Error(
          `google-cloud: unknown database ${JSON.stringify(database)}, expected "datastore" or "postgres"`
        );
    }
  }

  private _resolvePostgresConfig(): PostgresConfig {
    const raw = this.config.postgres ?? {};
    const resolved: PostgresConfig = {...raw};
    // same env-var-name indirection as the other options, so secrets stay out of config.yaml
    resolved.connectionString = setConfigValue(raw.connectionString, true);
    resolved.host = setConfigValue(raw.host);
    resolved.database = setConfigValue(raw.database);
    resolved.user = setConfigValue(raw.user);
    resolved.password = setConfigValue(raw.password, true);
    if (raw.port !== undefined) {
      resolved.port = Number(setConfigValue(raw.port));
      if (!Number.isInteger(resolved.port) || resolved.port <= 0) {
        throw new Error('google-cloud: postgres.port must resolve to a positive integer');
      }
    }
    return resolved;
  }

  private _getGoogleOptions(): DatastoreOptions {
    const options: DatastoreOptions = {};

    if (this.config.projectId) {
      options.projectId = this.config.projectId;
    } else if (process.env.GOOGLE_CLOUD_VERDACCIO_PROJECT_ID) {
      options.projectId = process.env.GOOGLE_CLOUD_VERDACCIO_PROJECT_ID;
    }

    const keyFileName = this.config.keyFilename || process.env.GOOGLE_CLOUD_VERDACCIO_KEY;
    if (keyFileName) {
      options.keyFilename = keyFileName;
      this.logger.warn(
        'google-cloud: using credentials file — only recommended for local development'
      );
    }

    if (this.config.datastoreEndpoint) {
      options.apiEndpoint = this.config.datastoreEndpoint;
    }

    debug('google options: %o', options);
    return options;
  }

  private _getStorageOptions(): StorageOptions {
    const options: StorageOptions = {};

    if (this.config.projectId) {
      options.projectId = this.config.projectId;
    } else if (process.env.GOOGLE_CLOUD_VERDACCIO_PROJECT_ID) {
      options.projectId = process.env.GOOGLE_CLOUD_VERDACCIO_PROJECT_ID;
    }

    const keyFileName = this.config.keyFilename || process.env.GOOGLE_CLOUD_VERDACCIO_KEY;
    if (keyFileName) {
      options.keyFilename = keyFileName;
    }

    if (this.config.apiEndpoint) {
      options.apiEndpoint = this.config.apiEndpoint;
    }

    return options;
  }

  /**
   * Verdaccio 9.x calls this with the query object and reads `item.package.name`,
   * so results must be SearchItem, not the bare package shape the old callback API used.
   */
  private toSearchItem(name: string): searchUtils.SearchItem {
    return {
      package: {name, path: name, time: Date.now()},
      score: {final: 1, detail: {quality: 1, popularity: 1, maintenance: 1}},
    };
  }

  /**
   * Called either as search(onPackage, onEnd) or as search(query). Both consumers read
   * `item.package.name`, so both must emit SearchItem and not the bare package shape.
   */
  public search(...args: any[]): any {
    if (typeof args[0] === 'function') {
      const onPackage = args[0] as (item: searchUtils.SearchItem, cb: () => void) => void;
      const onEnd = args[1] as (err?: Error) => void;
      // legacy signature: the third argument decides which names are emitted
      const validateName = args[2] as ((name: string) => boolean) | undefined;
      debug('search (callback)');
      void (async (): Promise<void> => {
        try {
          const names = await this.backend.listPackages();
          const selected = validateName
            ? names.filter((name): boolean => validateName(name))
            : names;
          debug('search (callback) emitting %d of %d packages', selected.length, names.length);
          for (const name of selected) {
            await new Promise<void>((resolve): void => {
              onPackage(this.toSearchItem(name), resolve);
            });
          }
          onEnd();
        } catch (err: any) {
          debug('search (callback) failed: %o', err);
          this.logger.error({err}, 'google-cloud: [search] failed: @{err.message}');
          // onEnd must always run, or the request hangs until the client gives up
          onEnd(err);
        }
      })();
      return;
    }

    const query = (args[0] ?? {}) as searchUtils.SearchQuery & {query?: searchUtils.SearchQuery};
    const text = (query.text ?? query.query?.text)?.toLowerCase();
    debug('search (promise) text=%o', text);
    return (async (): Promise<searchUtils.SearchItem[]> => {
      const names = await this.backend.listPackages();
      const matched = text
        ? names.filter((name): boolean => name.toLowerCase().includes(text))
        : names;
      debug('search (promise) matched %d of %d', matched.length, names.length);
      return matched.map((name): searchUtils.SearchItem => this.toSearchItem(name));
    })();
  }

  public async saveToken(token: Token): Promise<void> {
    await this.backend.saveToken(token);
  }

  public async deleteToken(user: string, tokenKey: string): Promise<void> {
    await this.backend.deleteToken(user, tokenKey);
  }

  public async readTokens(filter: TokenFilter): Promise<Token[]> {
    return this.backend.readTokens(filter);
  }

  public async getSecret(): Promise<string> {
    return this.backend.getSecret();
  }

  public async setSecret(secret: string): Promise<void> {
    await this.backend.setSecret(secret);
  }

  public add(name: string, cb: Callback): void {
    this.backend.addPackage(name).then(
      (): void => cb(null),
      (err: any): void => {
        debug('add package=%o failed: %o', name, err);
        this.logger.error({name, err: err.message}, 'google-cloud: [add] @{name} error @{err}');
        cb(errorUtils.getInternalError(DATABASE_ERROR));
      }
    );
  }

  public remove(name: string, cb: Callback): void {
    this.backend.removePackage(name).then(
      (): void => cb(null),
      (err: any): void => {
        debug('remove package=%o failed: %o', name, err);
        this.logger.error({name, err: err.message}, 'google-cloud: [remove] @{name} error @{err}');
        cb(errorUtils.getInternalError(DATABASE_ERROR));
      }
    );
  }

  public get(cb: Callback): void {
    this.backend.listPackages().then(
      (names: string[]): void => cb(null, names),
      (err: any): void => {
        debug('get packages failed: %o', err);
        this.logger.error({err: err.message}, 'google-cloud: [get] error @{err}');
        cb(errorUtils.getInternalError(DATABASE_ERROR));
      }
    );
  }

  public getPackageStorage(packageInfo: string): GoogleCloudStorageHandler {
    const {helper, config, logger, backend} = this;
    debug('getPackageStorage package=%o', packageInfo);
    return new GoogleCloudStorageHandler(
      packageInfo,
      helper,
      config,
      logger,
      backend.withPackageLock ? (backend as PackageLocker) : undefined
    );
  }
}
