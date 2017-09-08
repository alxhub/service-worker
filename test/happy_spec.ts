// The happy spec has tests for the happy path cases - when everything is behaving correctly.

import {CacheDatabase} from '../src/db-cache';
import {Driver} from '../src/driver';
import {Manifest} from '../src/manifest';
import {sha1} from '../src/sha1';

import {MockRequest} from '../testing/fetch';
import {MockFileSystemBuilder, MockServerStateBuilder, tmpHashTableForFs} from '../testing/mock';
import {SwTestHarness, SwTestHarnessBuilder} from '../testing/scope';

const dist = new MockFileSystemBuilder()
  .addFile('/foo.txt', 'this is foo')
  .addFile('/bar.txt', 'this is bar')
  .addFile('/baz.txt', 'this is baz')
  .addFile('/qux.txt', 'this is qux')
  .addUnhashedFile('/unhashed/a.txt', 'this is unhashed', {'Cache-Control': 'max-age=10'})
  .build();


const distUpdate = new MockFileSystemBuilder()
  .addFile('/foo.txt', 'this is foo v2')
  .addFile('/bar.txt', 'this is bar')
  .addFile('/baz.txt', 'this is baz v2')
  .addFile('/qux.txt', 'this is qux v2')
  .addUnhashedFile('/unhashed/a.txt', 'this is unhashed v2', {'Cache-Control': 'max-age=10'})
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
      patterns: [
        '/unhashed/.*',
      ],
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
      patterns: [
        '/unhashed/.*',
      ],
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

  it('cleans up properly when manually requested', async () => {
    expect(await makeRequest(scope, '/foo.txt')).toEqual('this is foo');
    await driver.initialized;

    scope.updateServerState(serverUpdate);
    expect(await driver.checkForUpdate()).toEqual(true);
    serverUpdate.clearRequests();

    expect(await makeRequest(scope, '/foo.txt', 'new')).toEqual('this is foo v2');

    // Delete the default client.
    scope.clients.remove('default');

    // After this, the old version should no longer be cached.
    await driver.cleanupCaches();
    expect(await makeRequest(scope, '/foo.txt')).toEqual('this is foo v2');

    serverUpdate.assertNoOtherRequests();
  });
  
  it('cleans up properly on restart', async () => {
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

    scope.clients.remove('default');

    scope.advance(12000);
    await driver.idle.empty;
    serverUpdate.clearRequests();

    driver = new Driver(scope, scope, new CacheDatabase(scope, scope));
    expect(await makeRequest(scope, '/foo.txt')).toEqual('this is foo v2');

    const oldManifestHash = sha1(JSON.stringify(manifest));
    const keys = await scope.caches.keys();
    const hasOldCaches = keys.some(name => name.startsWith(oldManifestHash + ':'));
    expect(hasOldCaches).toEqual(false);
  });

  describe('unhashed requests', () => {
    beforeEach(async () => {
      expect(await makeRequest(scope, '/foo.txt')).toEqual('this is foo');
      await driver.initialized;
      server.clearRequests();
    });

    it('are cached appropriately', async () => {
      expect(await makeRequest(scope, '/unhashed/a.txt')).toEqual('this is unhashed');
      server.assertSawRequestFor('/unhashed/a.txt');
      expect(await makeRequest(scope, '/unhashed/a.txt')).toEqual('this is unhashed');
      server.assertNoOtherRequests();
    });
    
    it('expire according to Cache-Control headers', async () => {
      expect(await makeRequest(scope, '/unhashed/a.txt')).toEqual('this is unhashed');
      server.clearRequests();

      // Update the resource on the server.
      scope.updateServerState(serverUpdate);

      // Move ahead by 15 seconds.
      scope.advance(15000);
      expect(await makeRequest(scope, '/unhashed/a.txt')).toEqual('this is unhashed');
      serverUpdate.assertNoOtherRequests();

      // Another 6 seconds.
      scope.advance(6000);
      await driver.idle.empty;
      serverUpdate.assertSawRequestFor('/unhashed/a.txt');

      // Now the new version of the resource should be served.
      expect(await makeRequest(scope, '/unhashed/a.txt')).toEqual('this is unhashed v2');
      server.assertNoOtherRequests();
    });

    it('survive serialization', async () => {
      expect(await makeRequest(scope, '/unhashed/a.txt')).toEqual('this is unhashed');
      server.clearRequests();

      const state = scope.caches.dehydrate();
      scope = new SwTestHarnessBuilder()
        .withCacheState(state)
        .withServerState(server)
        .build();
      driver = new Driver(scope, scope, new CacheDatabase(scope, scope));
      expect(await makeRequest(scope, '/foo.txt')).toEqual('this is foo');
      await driver.initialized;
      server.assertNoRequestFor('/unhashed/a.txt');
      server.clearRequests();

      expect(await makeRequest(scope, '/unhashed/a.txt')).toEqual('this is unhashed');
      server.assertNoOtherRequests();

      // Advance the clock by 6 seconds, triggering the idle tasks. If an idle task
      // was scheduled from the request above, it means that the metadata was not
      // properly saved.
      scope.advance(6000);
      await driver.idle.empty;
      server.assertNoRequestFor('/unhashed/a.txt');
    });

    it('get carried over during updates', async () => {
      expect(await makeRequest(scope, '/unhashed/a.txt')).toEqual('this is unhashed');
      server.clearRequests();

      scope = new SwTestHarnessBuilder()
        .withCacheState(scope.caches.dehydrate())
        .withServerState(serverUpdate)
        .build();
      driver = new Driver(scope, scope, new CacheDatabase(scope, scope));
      expect(await makeRequest(scope, '/foo.txt')).toEqual('this is foo');
      await driver.initialized;

      scope.advance(15000);
      await driver.idle.empty;
      serverUpdate.assertNoRequestFor('/unhashed/a.txt');
      serverUpdate.clearRequests();

      expect(await makeRequest(scope, '/unhashed/a.txt')).toEqual('this is unhashed');
      serverUpdate.assertNoOtherRequests();

      scope.advance(15000);
      await driver.idle.empty;
      serverUpdate.assertSawRequestFor('/unhashed/a.txt');

      expect(await makeRequest(scope, '/unhashed/a.txt')).toEqual('this is unhashed v2');
      serverUpdate.assertNoOtherRequests();
    });
  });
});

async function makeRequest(scope: SwTestHarness, url: string, clientId?: string): Promise<string|null> {
  const [resPromise, done] = scope.handleFetch(new MockRequest(url), clientId || 'default');
  await done;
  const res = await resPromise;
  scope.clients.add(clientId || 'default');
  if (res !== undefined) {
    return res.text();
  }
  return null;
}