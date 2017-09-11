import {Adapter} from './src/adapter';
import {Driver} from './src/driver';
import {CacheDatabase} from './src/db-cache';

const scope = self as any as ServiceWorkerGlobalScope;

const adapter = new Adapter();
const driver = new Driver(scope, adapter, new CacheDatabase(scope, adapter));
