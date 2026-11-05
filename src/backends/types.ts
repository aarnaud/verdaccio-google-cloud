import type {Token, TokenFilter} from '@verdaccio/types';

/** Registry state: which packages exist, the registry secret and auth tokens. Bytes live in GCS. */
export interface RegistryBackend {
  init(): Promise<void>;
  getSecret(): Promise<string>;
  setSecret(secret: string): Promise<void>;
  addPackage(name: string): Promise<void>;
  removePackage(name: string): Promise<void>;
  listPackages(): Promise<string[]>;
  saveToken(token: Token): Promise<void>;
  deleteToken(user: string, tokenKey: string): Promise<void>;
  readTokens(filter: TokenFilter): Promise<Token[]>;
  /** Serialises `fn` for one package across every replica sharing this backend. */
  withPackageLock?<T>(name: string, fn: () => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

export interface PackageLocker {
  withPackageLock<T>(name: string, fn: () => Promise<T>): Promise<T>;
}
