import {Driver} from '../src/driver';
import {CacheDatabase} from '../src/db-cache';

import {MockRequest} from '../testing/fetch';
import {MockFileSystemBuilder, MockServerStateBuilder, tmpManifestSingleAssetGroup} from '../testing/mock';
import {SwTestHarnessBuilder} from '../testing/scope';

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

fdescribe('Driver', () => {
  it('initializes correctly', async () => {
    const driver = new Driver(scope, scope, new CacheDatabase(scope, scope));
    const [res, ctx] = scope.handleFetch(new MockRequest('/foo.txt'));
  });
});