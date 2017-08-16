import {Adapter, Context} from '../src/adapter';
import {Manifest, AssetGroupConfig} from '../src/manifest';
import {sha1} from '../src/sha1'
import {MockCacheStorage} from './cache';
import {MockRequest, MockResponse} from './fetch';
import {MockServerState, MockServerStateBuilder} from './mock';

const EMPTY_SERVER_STATE = new MockServerStateBuilder().build();

export class SwTestHarnessBuilder {
  private server = EMPTY_SERVER_STATE;
  private caches = new MockCacheStorage();

  withCacheState(cache: string): SwTestHarnessBuilder {
    this.caches = new MockCacheStorage(cache);
    return this;
  }

  withServerState(state: MockServerState): SwTestHarnessBuilder {
    this.server = state;
    return this;
  }

  build(): SwTestHarness {
    return new SwTestHarness(this.server, this.caches);
  }
}

export class SwTestHarness implements ServiceWorkerGlobalScope, Adapter, Context {
  readonly clients: Clients = null!;
  private eventHandlers = new Map<string, Function>();
  readonly registration: ServiceWorkerRegistration = null!;

  constructor(private server: MockServerState, readonly caches: MockCacheStorage) {}

  updateServerState(server?: MockServerState): void {
    this.server = server || EMPTY_SERVER_STATE;
  }

  fetch(req: string|Request): Promise<Response> {
    if (typeof req === 'string') {
      return this.server.fetch(new MockRequest(req));
    } else {
      return this.server.fetch(req);
    }
  }

  addEventListener(event: string, handler: Function): void {
    this.eventHandlers.set(event, handler);
  }

  removeEventListener(event: string, handler?: Function): void {
    this.eventHandlers.delete(event);
  }

  newRequest(url: string): Request {
    return new MockRequest(url);
  }

  newResponse(body: string): Response {
    return new MockResponse(body);
  }

  async skipWaiting(): Promise<void> {}

  waitUntil(promise: Promise<void>): void {}

  handleFetch(req: Request, clientId?: string): [Promise<Response|undefined>, Promise<void>] {
    const ctx = new OneTimeContext();
    if (!this.eventHandlers.has('fetch')) {
      throw new Error('No fetch handler registered');
    }
    const event = new MockFetchEvent(req, ctx, clientId || null);
    this.eventHandlers.get('fetch')!.call(this, event);

    return [event.response, ctx.ready]; 
  }
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

class OneTimeContext implements Context {
  private queue: Promise<void>[] = [];

  waitUntil(promise: Promise<void>): void {
    this.queue.push(promise);
  }

  get ready(): Promise<void> {
    return (async () => {
      while (this.queue.length > 0) {
        await this.queue.shift();
      }
    })();
  } 
}

class MockFetchEvent {
  response: Promise<Response|undefined> = Promise.resolve(undefined);

  constructor(readonly request: Request, private ctx: Context, readonly clientId: string|null) {}

  respondWith(promise: Promise<Response>): Promise<Response> {
    this.response = promise;
    return promise;
  }

  waitUntil(promise: Promise<void>): void {
    this.ctx.waitUntil(promise);
  }
}