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
  .addFile('/baz.txt', 'this is baz')
  .addFile('/qux.txt', 'this is qux')
  .build();


const distUpdate = new MockFileSystemBuilder()
.addFile('/foo.txt', 'this is foo v2')
.addFile('/bar.txt', 'this is bar')
.addFile('/baz.txt', 'this is baz v2')
.addFile('/qux.txt', 'this is qux v2')
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
    {
      name: 'other',
      mode: 'lazy',
      urls: [
        '/baz.txt',
        '/qux.txt',
      ],
      patterns: [],
    },
  ],
  hashTable: tmpHashTableForFs(dist),
};

const manifestUpdate: Manifest = {
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
    {
      name: 'other',
      mode: 'lazy',
      urls: [
        '/baz.txt',
        '/qux.txt',
      ],
      patterns: [],
    },
  ],
  hashTable: tmpHashTableForFs(distUpdate),
}

const server = new MockServerStateBuilder()
  .withStaticFiles(dist)
  .withManifest(manifest)
  .build();

const serverUpdate = new MockServerStateBuilder()
  .withStaticFiles(distUpdate)
  .withManifest(manifestUpdate)
  .build();

const scope = new SwTestHarnessBuilder()
  .withServerState(server)
  .build();

describe('Driver', () => {
  let scope: SwTestHarness;
  let driver: Driver;

  beforeEach(() => {
    server.clearRequests();
    scope = new SwTestHarnessBuilder()
      .withServerState(server)
      .build();
    driver = new Driver(scope, scope, new CacheDatabase(scope, scope));
  });

  it('initializes prefetched content correctly, after a request kicks it off', async () => {
    expect(await makeRequest(scope, '/foo.txt')).toEqual('this is foo');
    await driver.initialized;
    server.assertSawRequestFor('/ngsw.json');
    server.assertSawRequestFor('/foo.txt');
    server.assertSawRequestFor('/bar.txt');
    expect(await makeRequest(scope, '/foo.txt')).toEqual('this is foo');
    expect(await makeRequest(scope, '/bar.txt')).toEqual('this is bar');
    server.assertNoOtherRequests();
  });

  it('caches lazy content on-request', async () => {
    expect(await makeRequest(scope, '/foo.txt')).toEqual('this is foo');
    await driver.initialized;
    server.clearRequests();
    expect(await makeRequest(scope, '/baz.txt')).toEqual('this is baz');
    server.assertSawRequestFor('/baz.txt');
    server.assertNoOtherRequests();
    expect(await makeRequest(scope, '/baz.txt')).toEqual('this is baz');
    server.assertNoOtherRequests();
    expect(await makeRequest(scope, '/qux.txt')).toEqual('this is qux');
    server.assertSawRequestFor('/qux.txt');
    server.assertNoOtherRequests();
  });

  it('updates to new content when requested', async () => {
    expect(await makeRequest(scope, '/foo.txt')).toEqual('this is foo');
    await driver.initialized;

    scope.updateServerState(serverUpdate);
    expect(await driver.checkForUpdate()).toEqual(true);
    serverUpdate.assertSawRequestFor('/ngsw.json');
    serverUpdate.assertSawRequestFor('/foo.txt');
    serverUpdate.assertNoOtherRequests();

    // Default client is still on the old version of the app.
    expect(await makeRequest(scope, '/foo.txt')).toEqual('this is foo');

    // Sending a new client id should result in the updated version being returned.
    expect(await makeRequest(scope, '/foo.txt', 'new')).toEqual('this is foo v2');

    // Of course, the old version should still work.
    expect(await makeRequest(scope, '/foo.txt')).toEqual('this is foo');

    expect(await makeRequest(scope, '/bar.txt')).toEqual('this is bar');
    serverUpdate.assertNoOtherRequests();
  });
  
  it('checks for updates on restart', async () => {
    expect(await makeRequest(scope, '/foo.txt')).toEqual('this is foo');
    await driver.initialized;

    scope = new SwTestHarnessBuilder()
      .withCacheState(scope.caches.dehydrate())
      .withServerState(serverUpdate)
      .build();
    driver = new Driver(scope, scope, new CacheDatabase(scope, scope));
    expect(await makeRequest(scope, '/foo.txt')).toEqual('this is foo');
    await driver.initialized;
    serverUpdate.assertNoOtherRequests();

    scope.advance(12000);
    await driver.idle.empty;
    serverUpdate.assertSawRequestFor('/ngsw.json');
    serverUpdate.assertSawRequestFor('/foo.txt');
    serverUpdate.assertNoOtherRequests();
  });

  it('preserves multiple client assignments across restarts', async () => {
    expect(await makeRequest(scope, '/foo.txt')).toEqual('this is foo');
    await driver.initialized;

    scope.updateServerState(serverUpdate);
    expect(await driver.checkForUpdate()).toEqual(true);
    expect(await makeRequest(scope, '/foo.txt', 'new')).toEqual('this is foo v2');
    serverUpdate.clearRequests();

    scope = new SwTestHarnessBuilder()
      .withServerState(serverUpdate)
      .withCacheState(scope.caches.dehydrate())
      .build();
    driver = new Driver(scope, scope, new CacheDatabase(scope, scope));

    expect(await makeRequest(scope, '/foo.txt')).toEqual('this is foo');
    expect(await makeRequest(scope, '/foo.txt', 'new')).toEqual('this is foo v2');
    serverUpdate.assertNoOtherRequests();
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