import type {Logger, Token, TokenFilter} from '@verdaccio/types';

import type {RegistryBackend} from './types';

import type {Datastore} from '@google-cloud/datastore';
import debugCore from 'debug';

const debug = debugCore('verdaccio:plugin:google-cloud');

export const DEFAULT_KIND = 'VerdaccioDataStore';

export default class DatastoreBackend implements RegistryBackend {
  public constructor(
    private readonly datastore: Datastore,
    private readonly kind: string,
    private readonly logger: Logger
  ) {}

  public async init(): Promise<void> {
    await this.getSecret();
  }

  public async getSecret(): Promise<string> {
    const key = this.datastore.key(['Secret', 'secret']);
    debug('getSecret');
    this.logger.trace('google-cloud: [datastore getSecret] init');

    try {
      const data = await this.datastore.get(key);
      const entities = data[0];
      debug('getSecret found=%o', !!entities);
      this.logger.trace({data}, 'google-cloud: [datastore getSecret] response @{data}');
      if (!entities) {
        return '';
      }
      return entities.secret;
    } catch (err) {
      debug('getSecret failed: %o', err);
      this.logger.trace({err}, 'google-cloud: [getSecret] error, returning empty secret');
      return '';
    }
  }

  public async setSecret(secret: string): Promise<void> {
    const key = this.datastore.key(['Secret', 'secret']);
    debug('setSecret');
    this.logger.trace('google-cloud: [datastore setSecret] added');
    await this.datastore.upsert({key, data: {secret}});
  }

  public async addPackage(name: string): Promise<void> {
    const key = this.datastore.key([this.kind, name]);
    debug('add package=%o', name);
    this.logger.trace({name}, 'google-cloud: [datastore add] @{name} init');
    await this.datastore.save({key, data: {name}});
    debug('add package=%o success', name);
    this.logger.trace({name}, 'google-cloud: [datastore add] @{name} has been added');
  }

  public async removePackage(name: string): Promise<void> {
    debug('remove package=%o', name);
    this.logger.trace({name}, 'google-cloud: [datastore remove] @{name} init');
    const entities = await this.getEntities();
    for (const item of entities) {
      if (item.name === name) {
        await this.datastore.delete(item.key);
      }
    }
    debug('remove package=%o success', name);
  }

  public async listPackages(): Promise<string[]> {
    debug('get all packages');
    this.logger.trace('google-cloud: [datastore get] init');
    const query = this.datastore.createQuery(this.kind);
    const [response] = await this.datastore.runQuery(query);
    const names = response.map((task: any): string => task.name).filter(Boolean);
    debug('get packages count=%d', names.length);
    this.logger.trace({names}, 'google-cloud: [datastore get] names @{names}');
    return names;
  }

  public async saveToken(token: Token): Promise<void> {
    debug('saveToken user=%o key=%o', token.user, token.key);
    this.logger.trace(
      {user: token.user, tokenKey: token.key},
      'google-cloud: [saveToken] saving token for user=@{user} key=@{tokenKey}'
    );
    const key = this.datastore.key(['Token', `${token.user}:${token.key}`]);
    await this.datastore.upsert({
      key,
      data: {
        user: token.user,
        key: token.key,
        token: token.token,
        readonly: token.readonly,
        created: token.created,
      },
    });
    debug('saveToken user=%o key=%o stored', token.user, token.key);
    this.logger.trace(
      {user: token.user, tokenKey: token.key},
      'google-cloud: [saveToken] stored user=@{user} key=@{tokenKey}'
    );
  }

  public async deleteToken(user: string, tokenKey: string): Promise<void> {
    debug('deleteToken user=%o key=%o', user, tokenKey);
    this.logger.trace(
      {user, tokenKey},
      'google-cloud: [deleteToken] deleting token user=@{user} key=@{tokenKey}'
    );
    const key = this.datastore.key(['Token', `${user}:${tokenKey}`]);
    await this.datastore.delete(key);
    debug('deleteToken user=%o key=%o deleted', user, tokenKey);
    this.logger.trace(
      {user, tokenKey},
      'google-cloud: [deleteToken] deleted user=@{user} key=@{tokenKey}'
    );
  }

  public async readTokens(filter: TokenFilter): Promise<Token[]> {
    debug('readTokens user=%o', filter.user);
    this.logger.trace(
      {user: filter.user},
      'google-cloud: [readTokens] querying tokens for user=@{user}'
    );
    const query = this.datastore.createQuery('Token').filter('user', filter.user);
    const [entities] = await this.datastore.runQuery(query);

    const tokens: Token[] = entities.map((entity: any) => ({
      user: entity.user as string,
      key: entity.key as string,
      token: entity.token as string,
      readonly: entity.readonly as boolean,
      created: entity.created as string,
    }));
    debug('readTokens user=%o found=%d', filter.user, tokens.length);
    this.logger.trace(
      {user: filter.user, count: tokens.length},
      'google-cloud: [readTokens] found @{count} tokens for user=@{user}'
    );
    return tokens;
  }

  // packages are stored under a NAME key, so the key must be reused as read: it cannot be
  // rebuilt from an id, which is undefined for name keys
  private async getEntities(): Promise<{name: string; key: any}[]> {
    const query = this.datastore.createQuery(this.kind);
    const [response] = await this.datastore.runQuery(query);
    const entities: {name: string; key: any}[] = [];
    for (const task of response as any[]) {
      if (task.name) {
        entities.push({key: task[this.datastore.KEY], name: task.name});
      }
    }
    return entities;
  }
}
