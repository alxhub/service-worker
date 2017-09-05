import {Adapter, Context} from './adapter';
import {Database, Table} from './database';
import {DataGroupConfig} from './manifest';

interface AgeRecord {
  age: number;
}

interface LruNode {
  url: string;
  previous: string|null;
  next: string|null;
}

interface LruState {
  head: string|null;
  tail: string|null;
  map: {[url: string]: LruNode|undefined};
  count: number;
}

class LruList {
  state: LruState;
  constructor(state?: LruState) {
    if (state === undefined) {
      state = {
        head: null,
        tail: null,
        map: {},
        count: 0,
      };
    }
    this.state = state;
  }

  get size(): number {
    return this.state.count;
  }

  /**
   * Remove the tail.
   */
  pop(): string|null {
    // If there is no tail, return null.
    if (this.state.tail === null) {
      return null;
    }

    const url = this.state.tail;

    // Special case if this is the last node.
    if (this.state.head === this.state.tail) {
      // When removing the last node, both head and tail pointers become null.
      this.state.head = null;
      this.state.tail = null;
    } else {
      // Normal node removal. All that needs to be done is to clear the next pointer
      // of the previous node and make it the new tail.
      const block = this.state.map[url]!;
      const previous = this.state.map[block.previous!]!;
      this.state.tail = previous.url;
      previous.next = block.next;
    }

    // In any case, this URL is no longer tracked, so remove it from the count and the
    // map of tracked URLs.
    delete this.state.map[url];
    this.state.count--;

    // This URL has been successfully evicted.
    return url;
  }
  
  remove(url: string): boolean {
    const node = this.state.map[url];
    if (node === undefined) {
      return false;
    }

    // Special case if removing the current head.
    if (this.state.head === url) {
      // The node is the current head. Special case the removal.
      if (node.next === null) {
        // This is the only node. Reset the cache to be empty.
        this.state.head = null;
        this.state.tail = null;
        this.state.map = {};
        this.state.count = 0;
        return true;
      }

      // There is at least one other node. Make the next node the new head.
      const next = this.state.map[node.next!]!;
      next.previous = null;
      this.state.head = next.url;
      this.state.count--;
      return true;
    } 

    // The node is not the head, so it has a previous. It may or may not be the tail.
    // If it is not, then it has a next. First, grab the previous node.
    const previous = this.state.map[node.previous!]!;
    
    // Fix the forward pointer to skip over node and go directly to node.next.
    previous.next = node.next;

    // node.next may or may not be set. If it is, fix the back pointer to skip over node.
    // If it's not set, then this node happened to be the tail, and the tail needs to be
    // updated to point to the previous node (removing the tail).
    if (node.next !== null) {
      // There is a next node, fix its back pointer to skip this node.
      this.state.map[node.next]!.previous = node.previous!;
    } else {
      // There is no next node - the accessed node must be the tail. Move the tail pointer.
      this.state.tail = node.previous!;
    }

    // Count the removal.
    this.state.count--;

    return true;
  }

  accessed(url: string): void {
    // When a URL is accessed, its node needs to be moved to the head of the chain.
    // This is accomplished in two steps:
    //
    // 1) remove the node from its position within the chain.
    // 2) insert the node as the new head.
    //
    // Sometimes, a URL is accessed which has not been seen before. In this case, step 1 can
    // be skipped completely (which will grow the chain by one). Of course, if the node is
    // already the head, this whole operation can be skipped.
    if (this.state.head === url) {
      // The URL is already in the head position, accessing it is a no-op.
      return;
    }

    // Look up the node in the map, and construct a new entry if it's 
    const node = this.state.map[url] || {url, next: null, previous: null};
    
    // Step 1: remove the node from its position within the chain, if it is in the chain.
    if (this.state.map[url] !== undefined) {
      this.remove(url);
    }

    // Step 2: insert the node at the head of the chain.
    
    // First, check if there's an existing head node. If there is, it has previous: null.
    // Its previous pointer should be set to the node we're inserting.
    if (this.state.head !== null) {
      this.state.map[this.state.head]!.previous = url;
    }

    // The next pointer of the node being inserted gets set to the old head, before the head
    // pointer is updated to this node.
    node.next = this.state.head;

    // The new head is the new node.
    this.state.head = url;

    // If there is no tail, then this is the first node, and is both the head and the tail.
    if (this.state.tail === null) {
      this.state.tail = url;
    }

    // Set the node in the map of nodes (if the URL has been seen before, this is a no-op)
    // and count the insertion.
    this.state.map[url] = node;
    this.state.count++;
  }
}

export class DataGroup {
  private readonly patterns: RegExp[];
  private readonly cache: Promise<Cache>;
  private readonly metadata: Promise<Cache>;
  
  // Lazily initialized LRU tracking.
  private _lru: LruList|null = null;

  private readonly lruTable: Promise<Table>;
  private readonly ageTable: Promise<Table>;

  constructor(private scope: ServiceWorkerGlobalScope, private adapter: Adapter, private config: DataGroupConfig, private db: Database, private prefix: string) {
    this.patterns = this.config.patterns.map(pattern => new RegExp(pattern));
    this.cache = this.scope.caches.open(`${this.prefix}:dynamic:${this.config.name}:cache`);
    this.lruTable = this.db.open(`${this.prefix}:dynamic:${this.config.name}:lru`);
    this.ageTable = this.db.open(`${this.prefix}:dynamic:${this.config.name}:age`);
  }

  /**
   * Lazily initialize/load the LRU chain.
   */
  async lru(): Promise<LruList> {
    if (this._lru === null) {
      const table = await this.lruTable;
      try {
        this._lru = new LruList(await table.read<LruState>('lru'))
      } catch (e) {
        this._lru = new LruList();
      }
    }
    return this._lru;
  }

  /**
   * Sync the LRU chain to non-volatile storage.
   */
  async syncLru(): Promise<void> {
    if (this._lru === null) {
      return;
    }
    const table = await this.lruTable;
    return table.write('lru', this._lru!.state);
  }

  async handleFetch(req: Request, ctx: Context): Promise<Response|null> {
    if (!this.patterns.some(pattern => pattern.test(req.url))) {
      return null;
    }

    const lru = await this.lru();

    // The URL matches this cache. First, check whether this is a mutating request or not.
    switch (req.method) {
      case 'OPTIONS':
        // Don't try to cache this - it's non-mutating, but is part of a mutating request.
        // Most likely SWs don't even see this, but this guard is here just in case.
        return null;
      case 'GET':
      case 'HEAD':
        // Look for a response in the cache. If one exists, return it.
        const cache = await this.cache;
        let res = await cache.match(req);
        if (res !== undefined) {
          // A response was found in the cache, but its age is not yet known. Look it up.
          try {
            const ageTable = await this.ageTable;
            const age = this.adapter.time - (await ageTable.read<AgeRecord>(req.url)).age;
            // If the response is young enough, use it.
            if (age <= this.config.maxAge) {
              // Successful match from the cache. Use the response, after marking it as having
              // been accessed.
              await lru.accessed(req.url);
              return res;
            }

            // Otherwise, or if there was an error, assume the response is expired, and evict it.
          } catch (e) {
            // Some error getting the age for the response. Assume it's expired.
          }

          lru.remove(req.url);
          await this.clearCacheForUrl(req.url);

          // TODO: avoid duplicate in event of network timeout, maybe.
          await this.syncLru();
        }

        // No match from the cache. Go to the network. Note that this is not an 'await'
        // call, networkFetch is the actual Promise. This is due to timeout handling.
        const networkFetch = this.scope.fetch(req);

        if (this.config.timeoutMs !== undefined) {
          const timeout = this.adapter.timeout(this.config.timeoutMs) as Promise<undefined>;
          res = await Promise.race([networkFetch, timeout]);
        } else {
          // Do a plain fetch.
          res = await networkFetch;
        }

        // Define the operation for caching the response from the server. This has to happen all
        // at once, so that the cache and LRU tracking remain in sync. If the network request
        // completes before the timeout, this logic will be run inline with the response flow.
        // If the request times out on the server, an error will be returned but the real network
        // request will still be running in the background, to be cached when it completes.
        const cacheResponse = async (res: Response) => {
          // Only cache successful responses.
          if (!res.ok) {
            return;
          }

          if (lru.size >= this.config.maxSize) {
            // The cache is too big, evict something.
            const evictedUrl = lru.pop();
            if (evictedUrl !== null) {
              await this.clearCacheForUrl(evictedUrl);
            }
          }

          // TODO: evaluate for possible race conditions during flaky network periods.

          // Mark this resource as having been accessed recently. This ensures it won't be evicted
          // until enough other resources are requested that it falls off the end of the LRU chain.
          lru.accessed(req.url);

          // Store the response in the cache.
          await cache.put(req, res);

          // Store the age of the cache.
          const ageTable = await this.ageTable;
          await ageTable.write(req.url, {age: this.adapter.time});

          // Sync the LRU chain to non-volatile storage.
          await this.syncLru();
        };

        // Since fetch() will always return a response, undefined indicates a timeout.
        if (res === undefined) {
          // The request timed out. Return a Gateway Timeout error.
          res = this.adapter.newResponse(null, {status: 504, statusText: 'Gateway Timeout'});

          // Cache the network response eventually.
          ctx.waitUntil((async () => {
            try {
              cacheResponse(await networkFetch);
            } catch (e) {
              // TODO: handle this error somehow?
            }
          })());
        }

        // The request completed in time, so cache it inline with the response flow.
        // Make sure to clone it so the real response can still be returned to the user.
        await cacheResponse(res.clone());
        return res;
      default:
        // This was a mutating request. Assume the cache for this URL is no longer valid.
        const wasCached = lru.remove(req.url);
        
        // If there was a cached entry, remove it.
        if (wasCached) {
          await this.clearCacheForUrl(req.url);
        }

        // Sync the LRU chain to non-volatile storage.
        await this.syncLru();

        // Finally, fall back on the network.
        return this.scope.fetch(req);
    }
  }

  async cleanup(): Promise<void> {
    // Remove both the cache and the database entries which track LRU stats.
    await Promise.all([
      this.scope.caches.delete(`${this.prefix}:dynamic:${this.config.name}:cache`),
      this.db.delete(`${this.prefix}:dynamic:${this.config.name}:age`),
      this.db.delete(`${this.prefix}:dynamic:${this.config.name}:lru`),
    ]);
  }

  private async clearCacheForUrl(url: string): Promise<void> {
    const cache = await this.cache;
    await Promise.all([
      cache.delete(this.adapter.newRequest(url, {method: 'GET'})),
      cache.delete(this.adapter.newRequest(url, {method: 'HEAD'})),
    ]);
    const ageTable = await this.ageTable;
    await ageTable.delete(url);
  }
}
