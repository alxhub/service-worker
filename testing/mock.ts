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
  constructor(private resources: Map<string, Response>) {}

  async fetch(req: Request): Promise<Response> {
    if (this.resources.has(req.url)) {
      return this.resources.get(req.url)!;
    }
    return new MockResponse(null, {status: 404, statusText: 'Not Found'});
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
        urls: files,
        patterns: [],
      }
    ],
    hashTable,
  };
}

export function tmpHashTable(manifest: Manifest): Map<string, string> {
  const map = new Map<string, string>();
  Object.keys(manifest.hashTable).forEach(url => {
    const hash = manifest.hashTable[url];
    map.set(url, hash);
  });
  return map;
}