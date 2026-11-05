import type {GoogleCloudConfig} from '../types';

import type {Bucket, File, Storage} from '@google-cloud/storage';

export interface IStorageHelper {
  getBucket(): Bucket;
  buildFilePath(name: string, fileName: string): File;
}

export default class StorageHelper implements IStorageHelper {
  private storage: Storage;
  private config: GoogleCloudConfig;

  public constructor(storage: Storage, config: GoogleCloudConfig) {
    this.config = config;
    this.storage = storage;
  }

  public buildFilePath(name: string, fileName: string): File {
    return this.getBucket().file(`${name}/${fileName}`);
  }

  public getBucket(): Bucket {
    return this.storage.bucket(this.config.bucket);
  }
}
