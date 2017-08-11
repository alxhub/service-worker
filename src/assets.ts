import {Adapter, Context} from './adapter';
import {Database} from './database';
import {AssetGroupConfig} from './manifest';
import {sha1} from './sha1';

export interface AssetGroup {
  fullyInitialize(): Promise<void>;

  handleFetch(req: Request, ctx: Context): Promise<Response|null>;

}

export class PrefetchAssetGroup implements AssetGroup {
  /**
   * A deduplication cache, to make sure the SW never makes two network requests for the same resource
   * at once.
   */
  private inFlightRequests = new Map<string, Promise<Response>>();

  constructor(
    private scope: ServiceWorkerGlobalScope,
    private adapter: Adapter,
    private config: AssetGroupConfig,
    private hashes: Map<string, string>,
    private db: Database,
    private prefix: string) {

  }

  async fullyInitialize(): Promise<void> {
    // Open the cache which actually holds requests.
    const cache = await this.scope.caches.open(`${this.prefix}:${this.config.name}:cache`);

    // Build a list of Requests that need to be cached.
    const reqs = this.config.urls.map(url => this.adapter.newRequest(url));

    // Cache them serially. As this reduce proceeds, each Promise waits on the last
    // before starting the fetch/cache operation for the next request. Any errors
    // cause fall-through to the final Promise which rejects.
    await reqs.reduce(async (previous: Promise<void>, req: Request) => {
      // Wait on all previous operations to complete.
      await previous;

      // First, check the cache to see if there is already a copy of this resource.
      const alreadyCached = (await cache.match(req)) !== undefined;
      
      // If the resource is in the cache already, it can be skipped.
      if (alreadyCached) {
        return;
      }

      // Determine whether the browser has already requested this resource. If it has, and it's not in the
      // cache yet, then it's either pending or has already failed. In both cases, it'll still be in
      // `inFlightRequests`.
      let fetchOp: Promise<Response>;

      // Check `inFlightRequests` to see if a request to this resource is pending.
      if (this.inFlightRequests.has(req.url)) {
        // A request is currently pending, no need to duplicate it.
        fetchOp = this.inFlightRequests.get(req.url)!;
      } else {
        // No request is currently pending. Make one and add it to `inFlightRequests` to avoid future
        // duplication.
        fetchOp = this.fetchFromNetwork(req);
        this.inFlightRequests.set(req.url, fetchOp);
      }

      // Wait for a response. If this fails, the request will remain in `inFlightRequests` indefinitely.
      const res = await fetchOp;

      // It's very important that only successful responses are cached. Unsuccessful responses should never be
      // cached as this can completely break applications.
      if (!res.ok) {
        throw new Error(`Response not Ok (fullyInitialize): request for ${req.url} returned response ${res.status} ${res.statusText}`);
      }

      // This response is safe to cache (as long as it's cloned). Wait until the cache operation is complete.
      await cache.put(req, res.clone());

      // Finally, it can be removed from `inFlightRequests`. This might result in a double-remove if some other
      // chain was already making this request too, but that won't hurt anything.
      this.inFlightRequests.delete(req.url);

    }, Promise.resolve());
    return null!;
  }


  async handleFetch(req: Request, ctx: Context): Promise<Response|null> {
    if (this.config.urls.indexOf(req.url) !== -1) {
      // This URL matches

    }
    return null;
  }

  /**
   * Load a particular asset from the network, accounting for hash validation.
   */
  private async fetchFromNetwork(req: Request): Promise<Response> {
    // If a hash is available for this resource, then compare the fetched version with the canonical hash.
    // Otherwise, the network version will have to be trusted.
    if (this.hashes.has(req.url)) {
      // It turns out this resource does have a hash. Look it up. Unless the fetched version matches this
      // hash, it's invalid and the whole manifest may need to be thrown out.
      const canonicalHash = this.hashes.get(req.url)!;

      // Ideally, the resource would be requested with cache-busting to guarantee the SW gets the freshest
      // version. However, doing this would eliminate any chance of the response being in the HTTP cache.
      // Given that the browser has recently actively loaded the page, it's likely that many of the responses
      // the SW needs to cache are in the HTTP cache and are fresh enough to use.
      //
      // In the future, this could be done by setting cacheMode to *only* check the browser cache for a
      // cached version of the resource, when cacheMode is fully supported. For now, the resource is fetched
      // directly, without cache-busting, and if the hash test fails a cache-busted request is tried before
      // concluding that the resource isn't correct. This gives the benefit of acceleration via the HTTP cache
      // without the risk of stale data, at the expense of a duplicate request in the event of a stale
      // response.

      // Fetch the resource from the network (possibly hitting the HTTP cache).
      const networkResult = await this.scope.fetch(req);

      // Hash the fetched resource (making sure to clone it so the response can be used/cached later).
      const fetchedHash = sha1(await networkResult.clone().arrayBuffer());

      // Compare the hashes.
      if (canonicalHash !== fetchedHash) {
        // Hash failure, the version that was retrieved under the default URL did not have the hash expected.
        // This could be because the HTTP cache got in the way and returned stale data, or because the version
        // on the server really doesn't match. A cache-busting request will differentiate these two situations.
        // TODO: handle case where the URL has parameters already (unlikely for assets).
        const cacheBustedResult = await this.scope.fetch(req.url + '?ngsw-cache-bust=' + Math.random());
        const cacheBustedHash = sha1(await cacheBustedResult.clone().arrayBuffer());

        // If the cache-busted version doesn't match, then the manifest is not an accurate representation of
        // the server's current set of files, and the SW should give up.
        if (canonicalHash !== cacheBustedHash) {
          throw new Error(`Hash mismatch (${req.url}): expected ${canonicalHash}, got ${fetchedHash}`);
        }

        // If it does match, then use the cache-busted result.
        return cacheBustedResult;
      }
      
      // Excellent, the version from the network matched on the first try, with no need for cache-busting.
      // Use it.
      return networkResult;
    } else {
      // This URL doesn't exist in our hash database, so it must be requested directly.
      return this.scope.fetch(req);
    }
  }
}