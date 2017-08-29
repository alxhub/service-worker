import {Adapter, Context} from './adapter';
import {Database} from './database';
import {DataGroupConfig} from './manifest';

interface LruNode {
  url: string;
  previous: string|null;
  next: string|null;
}

interface LruState {
  head: string|null;
  tail: string|null;
  map: {[url: string]: LruNode} & Object;
}

class LruList {
  constructor(private state: LruState) {}

  accessed(url: string): void {
    if (this.state.map.hasOwnProperty('foo')) {
    }
  }
}

export class DataGroup {
  private readonly patterns: RegExp[];
  private readonly cache: Promise<Cache>;
  private readonly metadata: Promise<Cache>;

  constructor(private scope: ServiceWorkerGlobalScope, private adapter: Adapter, private config: DataGroupConfig, private db: Database, private prefix: string) {
    this.patterns = this.config.patterns.map(pattern => new RegExp(pattern));
    this.cache = this.scope.caches.open(`${this.prefix}:${this.config.name}:cache`);
    this.metadata = this.scope.caches.open(`${this.prefix}:${this.config.name}:metadata`);
  }

  async handleFetch(req: Request, ctx: Context): Promise<Response|null> {
    if (!this.patterns.some(pattern => pattern.test(req.url))) {
      return null;
    }

    const cache = await this.cache;
    return null;
  }
}