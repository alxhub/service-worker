import {Adapter} from '../src/adapter';
import {Manifest, AssetGroupConfig} from '../src/manifest';
import {sha1} from '../src/sha1'
import {MockCacheStorage} from './cache';
import {FetchMock, MockRequest, MockResponse} from './fetch';

export class SwTestHarness extends FetchMock implements ServiceWorkerGlobalScope, Adapter {

  readonly caches: CacheStorage = new MockCacheStorage();
  readonly clients: Clients = null!;
  private eventHandlers = new Map<string, Function>();
  readonly registration: ServiceWorkerRegistration = null!;


  addEventListener(event: string, handler: Function): void {
    this.eventHandlers.set(event, handler);
  }

  removeEventListener(event: string, handler?: Function): void {
    this.eventHandlers.delete(event);
  }

  newRequest(url: string): Request {
    return new Request(url);
  }

  newResponse(body: string): Response {
    return new Response(body);
  }

  async skipWaiting(): Promise<void> {}
}

interface StaticFile {
  url: string;
  contents: string;
  hash: string;
}

export class AssetGroupBuilder {
  constructor(private up: ConfigBuilder, readonly name: string) {}

  files: StaticFile[] = [];

  addFile(url: string, contents: string): AssetGroupBuilder {
    this.files.push({url, contents, hash: sha1(contents)});
    return this;
  }

  finish(): ConfigBuilder {
    return this.up;
  }

  toManifestGroup(): AssetGroupConfig {
    return null!;
  }
}

export class ConfigBuilder {

  assetGroups = new Map<string, AssetGroupBuilder>();

  addAssetGroup(name: string): ConfigBuilder {
    const builder = new AssetGroupBuilder(this, name);
    this.assetGroups.set(name, builder);
    return this;
  }

  finish(): Manifest {
    const assetGroups = Array
      .from(this.assetGroups.values())
      .map(group => group.toManifestGroup());
    const hashTable = {};
    return {
      configVersion: 1,
      assetGroups,
      hashTable,
    }
  }
}