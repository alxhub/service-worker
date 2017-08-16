import {Driver} from '../src/driver';
import {CacheDatabase} from '../src/db-cache';

import {MockRequest} from '../testing/fetch';
import {MockFileSystemBuilder, MockServerStateBuilder, tmpManifestSingleAssetGroup} from '../testing/mock';
import {SwTestHarness, SwTestHarnessBuilder} from '../testing/scope';

const dist = new MockFileSystemBuilder()
  .addFile('/foo.txt', 'this is foo')
  .addFile('/bar.txt', 'this is bar')
  .build();

const manifest = tmpManifestSingleAssetGroup(dist);

const server = new MockServerStateBuilder()
  .withStaticFiles(dist)
  .withManifest(manifest)
  .build();

const scope = new SwTestHarnessBuilder()
  .withServerState(server)
  .build();

describe('Driver', () => {
  it('initializes correctly', async () => {
    const driver = new Driver(scope, scope, new CacheDatabase(scope, scope));
    expect(await makeRequest(scope, '/foo.txt')).toEqual('this is foo');
    await driver.initialized;
    scope.updateServerState();
    expect(await makeRequest(scope, '/foo.txt')).toEqual('this is foo');
  });
});

async function makeRequest(scope: SwTestHarness, url: string): Promise<string|null> {
  const [resPromise, done] = scope.handleFetch(new MockRequest(url));
  await done;
  const res = await resPromise;
  if (res !== undefined) {
    return res.text();
  }
  return null;
}