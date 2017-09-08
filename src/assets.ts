import {Adapter, Context} from './adapter';
import {CacheState, UpdateSource, UrlMetadata} from './api';
import {Database, Table} from './database';
import {IdleScheduler} from './idle';
import {AssetGroupConfig} from './manifest';
import {sha1} from './sha1';

export abstract class AssetGroup {
  /**
   * A deduplication cache, to make sure the SW never makes two network requests for the same
   * resource at once. Managed by `fetchAndCacheOnce`.
   */
  private inFlightRequests = new Map<string, Promise<Response>>();

  /**
   * Regular expression patterns.
   */
  protected patterns: RegExp[] = [];

  /**
   * A Promise which resolves to the `Cache` used to back this asset group. This is opened
   * from the constructor.
   */
  protected cache: Promise<Cache>;

  /**
   * Group name from the configuration.
   */
  readonly name: string;

  /**
   * Metadata associated with specific cache entries.
   */
  protected metadata: Promise<Table>;

  constructor(
      protected scope: ServiceWorkerGlobalScope,
      protected adapter: Adapter,
      protected idle: IdleScheduler,
      protected config: AssetGroupConfig,
      protected hashes: Map<string, string>,
      protected db: Database,
      protected prefix: string) {
    this.name = config.name;
    // Patterns in the config are regular expressions disguised as strings. Breathe life into them.
    this.patterns = this.config.patterns.map(pattern => new RegExp(pattern));
    
    // This is the primary cache, which holds all of the cached requests for this group. If a resource
    // isn't in this cache, it hasn't been fetched yet.
    this.cache = this.scope.caches.open(`${this.prefix}:${this.config.name}:cache`);

    this.metadata = this.db.open(`${this.prefix}:${this.config.name}:meta`);
  }

  abstract initializeFully(updateFrom?: UpdateSource): Promise<void>;

  async cleanup(): Promise<void> {
    await this.scope.caches.delete(`${this.prefix}:${this.config.name}:cache`);
  }

  async handleFetch(req: Request, ctx: Context): Promise<Response|null> {
    // Either the request matches one of the known resource URLs, one of the patterns for
    // dynamically matched URLs, or neither. Determine which is the case for this request in
    // order to decide how to handle it.
    if (this.config.urls.indexOf(req.url) !== -1 || this.patterns.some(pattern => pattern.test(req.url))) {
      // This URL matches a known resource. Either it's been cached already or it's missing, in
      // which case it needs to be loaded from the network.

      // Open the cache to check whether this resource is present.
      const cache = await this.cache;

      // Look for a cached response. If one exists, it can be used to resolve the fetch
      // operation.
      const cachedResponse = await cache.match(req);
      if (cachedResponse !== undefined) {
        // A response has already been cached (which presumably matches the hash for this
        // resource). Check whether it's safe to serve this resource from cache.
        if (this.hashes.has(req.url)) {
          // This resource has a hash, and thus is versioned by the manifest. It's safe to return
          // the response.
          return cachedResponse;
        } else {
          // This resource has no hash, and yet exists in the cache. Check how old this request is
          // to make sure it's still usable.
          if (await this.needToRevalidate(req, cachedResponse)) {
            this.idle.schedule(async () => {
              await this.fetchAndCacheOnce(req);
            })
          }

          // In either case (revalidation or not), the cached response must be good.
          return cachedResponse;
        }
      }
      // No already-cached response exists, so attempt a fetch/cache operation.
      const res = await this.fetchAndCacheOnce(req);

      // If this is successful, the response needs to be cloned as it might be used to respond to
      // multiple fetch operations at the same time.
      return res.clone();
    } else {
      return null;
    }
  }

  private async needToRevalidate(req: Request, res: Response): Promise<boolean> {
    // Three different strategies apply here:
    // 1) The request has a Cache-Control header, and thus expiration needs to be based on its age.
    // 2) The request has an Expires header, and expiration is based on the current timestamp.
    // 3) The request has no applicable caching headers, and must be revalidated.
    if (res.headers.has('Cache-Control')) {
      // Figure out if there is a max-age directive in the Cache-Control header.
      const cacheControl = res.headers.get('Cache-Control')!;
      const cacheDirectives = cacheControl
        // Directives are comma-separated within the Cache-Control header value.
        .split(',')
        // Make sure each directive doesn't have extraneous whitespace.
        .map(v => v.trim())
        // Some directives have values (like maxage and s-maxage)
        .map(v => v.split('='));
      
      // Lowercase all the directive names.
      cacheDirectives.forEach(v => v[0] = v[0].toLowerCase());

      // Find the max-age directive, if one exists.
      const cacheAge = cacheDirectives
        .filter(v => v[0] === 'max-age')
        .map(v => v[1])[0];

      if (cacheAge.length === 0) {
        // No usable TTL defined. Must assume that the response is stale.
        return true;
      }
      try {
        const maxAge = 1000 * Number.parseInt(cacheAge);

        // Determine the origin time of this request. If the SW has metadata on the request (which it
        // should), it will have the time the request was added to the cache. If it doesn't for some
        // reason, the request may have a Date header which will serve the same purpose.
        let ts: number;
        try {
          // Check the metadata table. If a timestamp is there, use it.
          const metaTable = await this.metadata;
          ts = (await metaTable.read<UrlMetadata>(req.url)).ts;
        } catch (e) {
          // Otherwise, look for a Date header.
          const date = res.headers.get('Date');
          if (date === null) {
            // Unable to determine when this response was created. Assume that it's stale, and
            // revalidate it.
            return true;
          }
          ts = Date.parse(date);
        }
        const age = this.adapter.time - ts;
        if (age < 0 || age > maxAge) {
        }
        return age < 0 || age > maxAge;
      } catch (e) {
        // Assume stale.
        return true;
      }
    } else if (res.headers.has('Expires')) {
      // Determine if the expiration time has passed.
      const expiresStr = res.headers.get('Expires')!;
      try {
        // The request needs to be revalidated if the current time is later than the expiration
        // time, if it parses correctly.
        return this.adapter.time > Date.parse(expiresStr);
      } catch (e) {
        // The expiration date failed to parse, so revalidate as a precaution.
        return true;
      }
    } else {
      // No way to evaluate staleness, so assume the response is already stale.
      res.headers.forEach((k, v) => {
      });
      return true;
    }
  }

  async fetchFromCacheOnly(url: string): Promise<CacheState|null> {
    const cache = await this.cache;
    const metaTable = await this.metadata;

    const response = await cache.match(this.adapter.newRequest(url));
    if (response === undefined) {
      return null;
    }

    let metadata: UrlMetadata|undefined = undefined;
    try {
      metadata = await metaTable.read<UrlMetadata>(url);
    } catch (e) {
      // Do nothing, not found.
    }

    return {response, metadata};
  }

  async unhashedResources(): Promise<string[]> {
    const cache = await this.cache;
    const keys = await cache.keys();
    return keys
      // TODO: optimize this
      .filter(url => this.config.urls.indexOf(url) === -1)
      .filter(url => this.patterns.some(pattern => pattern.test(url)));
  }

  protected async fetchAndCacheOnce(req: Request): Promise<Response> {
    // The `inFlightRequests` map holds information about which caching operations are currently
    // underway for known resources. If this request appears there, another "thread" is already
    // in the process of caching it, and this work should not be duplicated.
    if (this.inFlightRequests.has(req.url)) {
      // There is a caching operation already in progress for this request. Wait for it to
      // complete, and hopefully it will have yielded a useful response.
      return this.inFlightRequests.get(req.url)!;
    }


    // No other caching operation is being attempted for this resource, so it will be owned here.
    // Go to the network and get the correct version.
    const fetchOp = this.fetchFromNetwork(req);

    // Save this operation in `inFlightRequests` so any other "thread" attempting to cache it
    // will block on this chain instead of duplicating effort.
    this.inFlightRequests.set(req.url, fetchOp);

    // Make sure this attempt is cleaned up properly on failure.
    try {
      // Wait for a response. If this fails, the request will remain in `inFlightRequests`
      // indefinitely.
      const res = await fetchOp;


      // It's very important that only successful responses are cached. Unsuccessful responses
      // should never be cached as this can completely break applications.
      if (!res.ok) {
        throw new Error(`Response not Ok (fetchAndCacheOnce): request for ${req.url} returned response ${res.status} ${res.statusText}`);
      }

      // This response is safe to cache (as long as it's cloned). Wait until the cache operation
      // is complete.
      const cache = await this.scope.caches.open(`${this.prefix}:${this.config.name}:cache`);
      await cache.put(req, res.clone());

      // If the request is not hashed, update its metadata, especially the timestamp. This is needed
      // for future determination of whether this cached response is stale or not.
      if (!this.hashes.has(req.url)) {
        const meta: UrlMetadata = {ts: this.adapter.time};
        const metaTable = await this.metadata;
        await metaTable.write(req.url, meta);

      }

      return res;
    } finally {
      // Finally, it can be removed from `inFlightRequests`. This might result in a double-remove
      // if some other  chain was already making this request too, but that won't hurt anything.
      this.inFlightRequests.delete(req.url);
    }
  }

  /**
   * Load a particular asset from the network, accounting for hash validation.
   */
  protected async fetchFromNetwork(req: Request): Promise<Response> {
    // If a hash is available for this resource, then compare the fetched version with the
    // canonical hash. Otherwise, the network version will have to be trusted.
    if (this.hashes.has(req.url)) {
      // It turns out this resource does have a hash. Look it up. Unless the fetched version
      // matches this hash, it's invalid and the whole manifest may need to be thrown out.
      const canonicalHash = this.hashes.get(req.url)!;

      // Ideally, the resource would be requested with cache-busting to guarantee the SW gets
      // the freshest version. However, doing this would eliminate any chance of the response
      // being in the HTTP cache. Given that the browser has recently actively loaded the page,
      // it's likely that many of the responses the SW needs to cache are in the HTTP cache and
      // are fresh enough to use. In the future, this could be done by setting cacheMode to
      // *only* check the browser cache for a cached version of the resource, when cacheMode is
      // fully supported. For now, the resource is fetched directly, without cache-busting, and
      // if the hash test fails a cache-busted request is tried before concluding that the
      // resource isn't correct. This gives the benefit of acceleration via the HTTP cache
      // without the risk of stale data, at the expense of a duplicate request in the event of
      // a stale response.

      // Fetch the resource from the network (possibly hitting the HTTP cache).
      const networkResult = await this.scope.fetch(req);

      // Decide whether a cache-busted request is necessary. It might be for two independent
      // reasons: either the non-cache-busted request failed (hopefully transiently) or if the
      // hash of the content retrieved does not match the canonical hash from the manifest. It's
      // only valid to access the content of the first response if the request was successful.
      let makeCacheBustedRequest: boolean = networkResult.ok;
      if (makeCacheBustedRequest) {
        // The request was successful. A cache-busted request is only necessary if the hashes
        // don't match. Compare them, making sure to clone the response so it can be used later
        // if it proves to be valid.
        const fetchedHash = sha1(await networkResult.clone().text());
        makeCacheBustedRequest = (fetchedHash !== canonicalHash);
      }

      // Make a cache busted request to the network, if necessary.
      if (makeCacheBustedRequest) {
        // Hash failure, the version that was retrieved under the default URL did not have the
        // hash expected. This could be because the HTTP cache got in the way and returned stale
        // data, or because the version on the server really doesn't match. A cache-busting
        // request will differentiate these two situations.
        // TODO: handle case where the URL has parameters already (unlikely for assets).
        const cacheBustedResult = await this.scope.fetch(this.cacheBust(req.url));
        
        // If the response was unsuccessful, there's nothing more that can be done.
        if (!cacheBustedResult.ok) {
          throw new Error(`Response not Ok (fetchFromNetwork): cache busted request for ${req.url} returned response ${cacheBustedResult.status} ${cacheBustedResult.statusText}`)
        }

        // Hash the contents.
        const cacheBustedHash = sha1(await cacheBustedResult.clone().text());

        // If the cache-busted version doesn't match, then the manifest is not an accurate
        // representation of the server's current set of files, and the SW should give up.
        if (canonicalHash !== cacheBustedHash) {
          throw new Error(`Hash mismatch (${req.url}): expected ${canonicalHash}, got ${cacheBustedHash} (after cache busting)`);
        }

        // If it does match, then use the cache-busted result.
        return cacheBustedResult;
      }
      
      // Excellent, the version from the network matched on the first try, with no need for
      // cache-busting. Use it.
      return networkResult;
    } else {
      // This URL doesn't exist in our hash database, so it must be requested directly.
      return this.scope.fetch(req);
    }
  }

  protected async maybeUpdate(updateFrom: UpdateSource, req: Request, cache: Cache): Promise<boolean> {
    // Check if this resource is hashed and already exists in the cache of a prior version.
    if (this.hashes.has(req.url)) {
      const hash = this.hashes.get(req.url)!;

      // Check the caches of prior versions, using the hash to ensure the correct version of
      // the resource is loaded.
      const res = await updateFrom.lookupResourceWithHash(req.url, hash);

      // If a previously cached version was available, copy it over to this cache.
      if (res !== null) {
        // Copy to this cache.
        await cache.put(req, res);

        // No need to do anything further with this resource, it's now cached properly.
        return true;
      }
    }

    // No up-to-date version of this resource could be found.
    return false;
  }

  private cacheBust(url: string): string {
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'ngsw-cache-bust=' + Math.random();
  }
}

export class PrefetchAssetGroup extends AssetGroup {
  async initializeFully(updateFrom?: UpdateSource): Promise<void> {
    // Open the cache which actually holds requests.
    const cache = await this.cache;

    // Cache all known resources serially. As this reduce proceeds, each Promise waits
    // on the last before starting the fetch/cache operation for the next request. Any
    // errors cause fall-through to the final Promise which rejects.
    await this.config.urls.reduce(async (previous: Promise<void>, url: string) => {
      // Wait on all previous operations to complete.
      await previous;

      // Construct the Request for this url.
      const req = this.adapter.newRequest(url);

      // First, check the cache to see if there is already a copy of this resource.
      const alreadyCached = (await cache.match(req)) !== undefined;

      // If the resource is in the cache already, it can be skipped.
      if (alreadyCached) {
        return;
      }

      // If an update source is available.
      if (updateFrom !== undefined && await this.maybeUpdate(updateFrom, req, cache)) {
        return;
      }

      // Otherwise, go to the network and hopefully cache the response (if successful).
      await this.fetchAndCacheOnce(req);
    }, Promise.resolve());

    // Handle updating of unknown (unhashed) resources.
    if (updateFrom !== undefined) {
      const metaTable = await this.metadata;
      let resources = (await updateFrom.previouslyCachedResources());
        resources = resources.filter(url => this.patterns.some(pattern => pattern.test(url)));
      await resources.reduce(async (previous, url) => {
        await previous;
        const req = this.adapter.newRequest(url);

        const alreadyCached = (await cache.match(req) !== undefined);
        if (alreadyCached) {
          return;
        }

        const res = await updateFrom.lookupResourceWithoutHash(url);
        if (res === null || res.metadata === undefined) {
          // Unexpected, but not harmful.
          return;
        }

        await cache.put(req, res.response);
        await metaTable.write(url, res.metadata);
      }, Promise.resolve());
    }
  }
}

export class LazyAssetGroup extends AssetGroup {
  async initializeFully(updateFrom?: UpdateSource): Promise<void> {
    // No action necessary if no update source is available - resources managed in this group
    // are all lazily loaded, so there's nothing to initialize.
    if (updateFrom === undefined) {
      return;
    }

    // Open the cache which actually holds requests.
    const cache = await this.cache;

    // Loop through the listed resources, caching any which are available.
    await this.config.urls.reduce(async (previous: Promise<void>, url: string) => {
      // Wait on all previous operations to complete.
      await previous;
      
      // Construct the Request for this url.
      const req = this.adapter.newRequest(url);

      // First, check the cache to see if there is already a copy of this resource.
      const alreadyCached = (await cache.match(req)) !== undefined;
      
      // If the resource is in the cache already, it can be skipped.
      if (alreadyCached) {
        return;
      }
      
      // The return value of `maybeUpdate` is unimportant - whether it cached successfully
      // or not, no action is taken.
      await this.maybeUpdate(updateFrom, req, cache);
    }, Promise.resolve())
  }
}