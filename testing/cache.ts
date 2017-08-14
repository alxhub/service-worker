export class MockCacheStorage implements CacheStorage {

  private caches = new Map<string, MockCache>();

  async has(name: string): Promise<boolean> {
    return this.caches.has(name);
  }

  async keys(): Promise<string[]> {
    return Array.from(this.caches.keys());
  }

  async open(name: string): Promise<Cache> {
    if (!this.caches.has(name)) {
      this.caches.set(name, new MockCache());
    }
    return this.caches.get(name)!;
  }

  async match(req: Request): Promise<Response|undefined> {
    return await Array
      .from(this.caches.values())
      .reduce<Promise<Response|undefined>>(async (answer, cache): Promise<Response|undefined> => {
        const curr = await answer;
        if (curr !== undefined) {
          return curr;
        }

        return cache.match(req);
      }, Promise.resolve<Response|undefined>(undefined));
  }

  async 'delete'(name: string): Promise<boolean> {
    if (this.caches.has(name)) {
      this.caches.delete(name);
      return true;
    }
    return false;
  }
}

export class MockCache implements Cache {
  private cache = new Map<string, Response>();

  async add(request: RequestInfo): Promise<void> {
    throw 'Not implemented';
  }

  async addAll(requests: RequestInfo[]): Promise<void> {
    throw 'Not implemented';
  }

  async 'delete'(request: RequestInfo): Promise<boolean> {
    const url = (typeof request === 'string' ? request : request.url);
    if (this.cache.has(url)) {
      this.cache.delete(url);
      return true;
    }
    return false;
  }

  async keys(match?: Request|string): Promise<string[]> {
    if (match !== undefined) {
      throw 'Not implemented';
    }
    return Array.from(this.cache.keys());
  }

  async match(request: RequestInfo, options?: CacheQueryOptions): Promise<Response> {
    const url = (typeof request === 'string' ? request : request.url);
    // TODO: cleanup typings. Typescript doesn't know this can resolve to undefined.
    return this.cache.get(url)!;
  }


  async matchAll(request?: Request|string, options?: CacheQueryOptions): Promise<Response[]> {
    if (request === undefined) {
      return Array.from(this.cache.values());
    }
    const url = (typeof request === 'string' ? request : request.url);
    if (this.cache.has(url)) {
      return [this.cache.get(url)!];
    } else {
      return [];
    }
  }

  async put(request: RequestInfo, response: Response): Promise<void> {
    const url = (typeof request === 'string' ? request : request.url);
    this.cache.set(url, response);
    return;
  }
}