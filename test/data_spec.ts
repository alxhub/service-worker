// The happy spec has tests for the happy path cases - when everything is behaving correctly.

import {CacheDatabase} from '../src/db-cache';
import {Driver} from '../src/driver';
import {Manifest} from '../src/manifest';

import {MockRequest} from '../testing/fetch';
import {MockFileSystemBuilder, MockServerStateBuilder, tmpHashTableForFs} from '../testing/mock';
import {SwTestHarness, SwTestHarnessBuilder} from '../testing/scope';

const dist = new MockFileSystemBuilder()
  .addFile('/foo.txt', 'this is foo')
  .addFile('/bar.txt', 'this is bar')
  .addFile('/api/test', 'version 1')
  .addFile('/api/a', 'version A')
  .addFile('/api/b', 'version B')
  .addFile('/api/c', 'version C')
  .addFile('/api/d', 'version D')
  .addFile('/api/e', 'version E')
  .build();


const distUpdate = new MockFileSystemBuilder()
.addFile('/foo.txt', 'this is foo v2')
.addFile('/bar.txt', 'this is bar')
.addFile('/api/test', 'version 2')
.build();

const manifest: Manifest = {
  configVersion: 1,
  assetGroups: [
    {
      name: 'assets',
      mode: 'prefetch',
      urls: [
        '/foo.txt',
        '/bar.txt',
      ],
      patterns: [],
    },
  ],
  dataGroups: [
    {
      name: 'test',
      maxSize: 3,
      patterns: ['^/api/.*$'],
      timeoutMs: 1000,
      maxAge: 5000,
    },
  ],
  hashTable: tmpHashTableForFs(dist),
};


const server = new MockServerStateBuilder()
  .withStaticFiles(dist)
  .withManifest(manifest)
  .build();

const serverUpdate = new MockServerStateBuilder()
  .withStaticFiles(distUpdate)
  .withManifest(manifest)
  .build();

const scope = new SwTestHarnessBuilder()
  .withServerState(server)
  .build();

describe('data cache', () => {
  let scope: SwTestHarness;
  let driver: Driver;

  beforeEach(async () => {
    server.clearRequests();
    scope = new SwTestHarnessBuilder()
      .withServerState(server)
      .build();
    driver = new Driver(scope, scope, new CacheDatabase(scope, scope));

    // Initialize.
    expect(await makeRequest(scope, '/foo.txt')).toEqual('this is foo');
    await driver.initialized;
    server.clearRequests();
  });

  it('caches a basic request', async () => {
    expect(await makeRequest(scope, '/api/test')).toEqual('version 1');
    server.assertSawRequestFor('/api/test');
    scope.advance(1000);
    expect(await makeRequest(scope, '/api/test')).toEqual('version 1');
    server.assertNoOtherRequests();
  });
  
  it('refreshes after awhile', async () => {
    expect(await makeRequest(scope, '/api/test')).toEqual('version 1');
    server.clearRequests();
    scope.advance(10000);
    scope.updateServerState(serverUpdate);
    expect(await makeRequest(scope, '/api/test')).toEqual('version 2');
  });

  it('expires the least recently used entry', async () => {
    expect(await makeRequest(scope, '/api/a')).toEqual('version A');
    expect(await makeRequest(scope, '/api/b')).toEqual('version B');
    expect(await makeRequest(scope, '/api/c')).toEqual('version C');
    expect(await makeRequest(scope, '/api/d')).toEqual('version D');
    expect(await makeRequest(scope, '/api/e')).toEqual('version E');
    server.clearRequests();
    expect(await makeRequest(scope, '/api/c')).toEqual('version C');
    expect(await makeRequest(scope, '/api/d')).toEqual('version D');
    expect(await makeRequest(scope, '/api/e')).toEqual('version E');
    server.assertNoOtherRequests();
    expect(await makeRequest(scope, '/api/a')).toEqual('version A');
    expect(await makeRequest(scope, '/api/b')).toEqual('version B');
    server.assertSawRequestFor('/api/a');
    server.assertSawRequestFor('/api/b');
    server.assertNoOtherRequests();
  });
});

async function makeRequest(scope: SwTestHarness, url: string, clientId?: string): Promise<string|null> {
  const [resPromise, done] = scope.handleFetch(new MockRequest(url), clientId || 'default');
  await done;
  const res = await resPromise;
  if (res !== undefined) {
    return res.text();
  }
  return null;
}