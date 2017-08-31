import {Manifest, AssetGroupConfig} from '../src/manifest';
import {sha1} from '../src/sha1';
import {MockResponse} from './fetch';

export class MockFile {
  constructor(readonly path: string, readonly contents: string) {}

  get hash(): string {
    return sha1(this.contents);
  }
}

export class MockFileSystemBuilder {
  private resources = new Map<string, MockFile>();

  addFile(path: string, contents: string): MockFileSystemBuilder {
    this.resources.set(path, new MockFile(path, contents));
    return this;
  }

  build(): MockFileSystem {
    return new MockFileSystem(this.resources);
  }
}

export class MockFileSystem {
  constructor(private resources: Map<string, MockFile>) {}

  lookup(path: string): MockFile|undefined {
    return this.resources.get(path);
  }

  extend(): MockFileSystemBuilder {
    const builder = new MockFileSystemBuilder();
    Array.from(this.resources.keys()).forEach(path => {
      builder.addFile(path, this.resources.get(path)!.contents);
    });
    return builder;
  }

  list(): string[] {
    return Array.from(this.resources.keys());
  }
}

export class MockServerStateBuilder {
  private resources = new Map<string, Response>();

  withStaticFiles(fs: MockFileSystem): MockServerStateBuilder {
    fs.list().forEach(path => {
      const file = fs.lookup(path)!;
      this.resources.set(path, new MockResponse(file.contents));
    })
    return this;
  }

  withManifest(manifest: Manifest): MockServerStateBuilder {
    this.resources.set('/ngsw.json', new MockResponse(JSON.stringify(manifest)));
    return this;
  }

  build(): MockServerState {
    return new MockServerState(this.resources);
  }
}

export class MockServerState {
  private requests: Request[] = [];

  constructor(private resources: Map<string, Response>) {}

  async fetch(req: Request): Promise<Response> {
    const url = req.url.split('?')[0];
    this.requests.push(req);
    if (this.resources.has(url)) {
      return this.resources.get(url)!.clone();
    }
    return new MockResponse(null, {status: 404, statusText: 'Not Found'});
  }

  assertSawRequestFor(url: string): void {
    if (!this.sawRequestFor(url)) {
      throw new Error(`Expected request for ${url}, got none.`);
    }
  }

  assertNoRequestFor(url: string): void {
    if (this.sawRequestFor(url)) {
      throw new Error(`Expected no request for ${url} but saw one.`);
    }
  }

  sawRequestFor(url: string): boolean {
    const matching = this.requests.filter(req => req.url.split('?')[0] === url);
    if (matching.length > 0) {
      this.requests = this.requests.filter(req => req !== matching[0]);
      return true;
    }
    return false;
  }

  assertNoOtherRequests(): void {
    if (!this.noOtherRequests()) {
      throw new Error(`Expected no other requests, got requests for ${this.requests.map(req => req.url.split('?')[0]).join(', ')}`);
    }
  }

  noOtherRequests(): boolean {
    return this.requests.length === 0;
  }

  clearRequests(): void {
    this.requests = [];
  }
}

export function tmpManifestSingleAssetGroup(fs: MockFileSystem): Manifest {
  const files = fs.list();
  const hashTable: {[url: string]: string} = {};
  files.forEach(path => {
    hashTable[path] = fs.lookup(path)!.hash;
  });
  return {
    configVersion: 1,
    assetGroups: [
      {
        name: 'group',
        mode: 'prefetch',
        urls: files,
        patterns: [],
      },
    ],
    hashTable,
  };
}

export function tmpHashTableForFs(fs: MockFileSystem): {[url: string]: string} {
  const table: {[url: string]: string} = {};
  fs.list().forEach(path => {
    table[path] = fs.lookup(path)!.hash;
  });
  return table;
}

export function tmpHashTable(manifest: Manifest): Map<string, string> {
  const map = new Map<string, string>();
  Object.keys(manifest.hashTable).forEach(url => {
    const hash = manifest.hashTable[url];
    map.set(url, hash);
  });
  return map;
}