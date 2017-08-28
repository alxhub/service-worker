import {Adapter, Context} from './adapter';
import {UpdateSource} from './api';
import {Database} from './database';
import {Manifest} from './manifest';

import {AssetGroup, LazyAssetGroup, PrefetchAssetGroup} from './assets';

export class AppVersion implements UpdateSource {
  private hashTable = new Map<string, string>();
  private assetGroupsByName = new Map<string, AssetGroup>();
  private assetGroups: AssetGroup[];

  /**
   * Tracks whether the manifest has encountered any inconsistencies.
   */
  private _okay = true;

  get okay(): boolean {
    return this._okay;
  }

  constructor(private scope: ServiceWorkerGlobalScope, private adapter: Adapter, private database: Database, private manifest: Manifest, private manifestHash: string) {
    // The hashTable within the manifest is an Object - convert it to a Map for easier lookups.
    Object.keys(this.manifest.hashTable).forEach(url => {
      this.hashTable.set(url, this.manifest.hashTable[url]);
    });

    // Process each `AssetGroup` declared in the manifest. Each declared group gets an `AssetGroup` instance
    // created for it, of a type that depends on the configuration mode.
    this.assetGroups = (manifest.assetGroups || []).map(config => {
      // Every asset group has a cache that's prefixed by the manifest hash and the name of the group.
      const prefix = `${this.manifestHash}:assets:${config.name}`;
      // Check the caching mode, which determines when resources will be fetched/updated.
      switch (config.mode) {
        case 'prefetch':
          return new PrefetchAssetGroup(this.scope, this.adapter, config, this.hashTable, this.database, prefix);
        case 'lazy':
          return new LazyAssetGroup(this.scope, this.adapter, config, this.hashTable, this.database, prefix);
      }
    });

    // Populate the `assetGroupsByName` map.
    this.assetGroups.forEach(group => this.assetGroupsByName.set(group.name, group));
  }

  /**
   * Fully initialize this version of the application. If this Promise resolves successfully, all required
   * data has been safely downloaded.
   */
  async initializeFully(updateFrom?: UpdateSource): Promise<void> {
    try {
      // Fully initialize each asset group, in series. Starts with an empty Promise, and waits for the previous
      // groups to have been initialized before initializing the next one in turn.
      await this.assetGroups.reduce<Promise<void>>(async (previous, group) => {
        // Wait for the previous groups to complete initialization. If there is a failure, this will throw, and
        // each subsequent group will throw, until the whole sequence fails.
        await previous;

        // Initialize this group.
        return group.initializeFully(updateFrom);
      }, Promise.resolve());
    } catch (err) {
      this._okay = false;
      throw err;
    }
  }

  handleFetch(req: Request, context: Context): Promise<Response|null> {
    // Check the request against each `AssetGroup` in sequence. If an `AssetGroup` can't handle the request,
    // it will return `null`. Thus, the first non-null response is the SW's answer to the request. So reduce
    // the group list, keeping track of a possible response. If there is one, it gets passed through, and if
    // not the next group is consulted to produce a candidate response.
    return this.assetGroups.reduce<Promise<Response|null>>(async (potentialResponse, group) => {
      // Wait on the previous potential response. If it's not null, it should just be passed through.
      const resp = await potentialResponse;
      if (resp !== null) {
        return resp;
      }
      
      // No response has been found yet. Maybe this group will have one.
      return group.handleFetch(req, context);
    }, Promise.resolve(null));
  }

  async lookupResourceWithHash(url: string, hash: string): Promise<Response|null> {
    const req = this.adapter.newRequest(url);

    // Verify that this version has the requested resource cached. If not, there's no point in trying.
    if (!this.hashTable.has(url)) {
      return null;
    }

    // Next, check whether the resource has the correct hash. If not, any cached response isn't usable.
    if (this.hashTable.get(url)! !== hash) {
      return null;
    }

    // TODO: no-op context and appropriate contract. Currently this is a violation of the typings and could
    // cause issues if handleFetch() has side effects. A better strategy to deal with side effects is needed.
    return this.handleFetch(req, null!);
  }
}