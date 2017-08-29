import {Adapter} from './adapter';
import {Database, Table, NotFound} from './database';

export class CacheDatabase implements Database {
  private tables = new Map<string, Promise<CacheTable>>();

  constructor(private scope: ServiceWorkerGlobalScope, private adapter: Adapter) {}

  'delete'(name: string): Promise<boolean> {
    if (this.tables.has(name)) {
      this.tables.delete(name);
    }
    return this.scope.caches.delete(`ngsw:db:${name}`);
  }

  list(): Promise<string[]> {
    return this
      .scope
      .caches
      .keys()
      .then(keys => keys
        .filter(key => key.startsWith('ngsw:db:'))
      );
  }

  open(name: string): Promise<Table> {
    if (!this.tables.has(name)) {
      const table = this
        .scope
        .caches
        .open(`ngsw:db:${name}`)
        .then(cache => new CacheTable(name, cache, this.adapter));
      this.tables.set(name, table);
    }
    return this.tables.get(name)!;
  }
}

export class CacheTable implements Table {

  constructor(readonly table: string, private cache: Cache, private adapter: Adapter) {}

  private request(key: string): Request {
    return this.adapter.newRequest('/' + key);
  }

  'delete'(key: string): Promise<boolean> {
    return this.cache.delete(this.request(key));
  }

  keys(): Promise<string[]> {
    return this
      .cache
      .keys()
      .then(keys => keys.map(key => key.substr(1)));
  }

  read(key: string): Promise<any> {
    return this
      .cache
      .match(this.request(key))
      .then(res => {
        if (res === undefined) {
          return Promise.reject(new NotFound(this.table, key));
        }
        return res.json();
      });
  }

  write(key: string, value: Object): Promise<void> {
    return this
      .cache
      .put(this.request(key), this.adapter.newResponse(JSON.stringify(value)));
  }

}