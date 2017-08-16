import {PrefetchAssetGroup} from '../src/assets';
import {CacheDatabase} from '../src/db-cache';
import {SwTestHarnessBuilder} from '../testing/scope';
import {MockFileSystemBuilder, MockServerStateBuilder, tmpManifestSingleAssetGroup, tmpHashTable} from '../testing/mock';


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

const db = new CacheDatabase(scope, scope);

describe('prefetch assets', () => {
  let group: PrefetchAssetGroup;
  beforeEach(() => {
    group = new PrefetchAssetGroup(scope, scope, manifest.assetGroups![0], tmpHashTable(manifest), db, 'test');
  });
  it('initializes without crashing', async () => {
    await group.fullyInitialize();
  });
  it('fully caches the two files', async () => {
    await group.fullyInitialize();
    scope.updateServerState();
    const res1 = await group.handleFetch(scope.newRequest('/foo.txt'), scope);
    const res2 = await group.handleFetch(scope.newRequest('/bar.txt'), scope);
    expect(await res1!.text()).toEqual('this is foo');
    expect(await res2!.text()).toEqual('this is bar');
  });
  it('persists the cache across restarts', async () => {
    await group.fullyInitialize();
    const freshScope = new SwTestHarnessBuilder()
      .withCacheState(scope.caches.dehydrate())
      .build();
    group = new PrefetchAssetGroup(freshScope, freshScope, manifest.assetGroups![0], tmpHashTable(manifest), new CacheDatabase(freshScope, freshScope), 'test');
    await group.fullyInitialize();
    const res1 = await group.handleFetch(scope.newRequest('/foo.txt'), scope);
    const res2 = await group.handleFetch(scope.newRequest('/bar.txt'), scope);
    expect(await res1!.text()).toEqual('this is foo');
    expect(await res2!.text()).toEqual('this is bar');
  });
});
