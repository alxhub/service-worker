import {Adapter, Context} from './adapter';
import {UpdateSource} from './api';
import {AppVersion} from './app-version';
import {Database, Table} from './database';
import {Manifest, ManifestHash, hashManifest} from './manifest';

type ClientId = string;

type ManifestMap = {[hash: string]: Manifest};
type ClientAssignments = {[id: string]: ManifestHash};

interface LatestEntry {
  latest: string;
}

enum DriverReadyState {
  // The SW is operating in a normal mode, responding to all traffic.
  NORMAL,

  // The SW does not have a clean installation of the latest version of the app, but older cached versions
  // are safe to use so long as they don't try to fetch new dependencies. This is a degraded state.
  EXISTING_CLIENTS_ONLY,

  // The SW has decided that caching is completely unreliable, and is forgoing request handling until the
  // next restart.
  SAFE_MODE,
}

export class Driver implements UpdateSource {
  /**
   * Tracks the current readiness condition under which the SW is operating. This controls whether the SW
   * attempts to respond to some or all requests.
   */
  state: DriverReadyState = DriverReadyState.NORMAL;

  /**
   * Tracks whether the SW is in an initialized state or not. Before initialization, it's not legal to
   * respond to requests.
   */
  initialized: Promise<void>|null = null;

  /**
   * Maps client IDs to the manifest hash of the application version being used to serve them. If a client
   * ID is not present here, it has not yet been assigned a version.
   *
   * If a ManifestHash appears here, it is also present in the `versions` map below.
   */
  private clientVersionMap = new Map<ClientId, ManifestHash>();

  /**
   * Maps manifest hashes to instances of `AppVersion` for those manifests.
   */
  private versions = new Map<ManifestHash, AppVersion>();

  /**
   * The latest version fetched from the server.
   *
   * Valid after initialization has completed.
   */
  private latestHash: ManifestHash|null = null;

  constructor(private scope: ServiceWorkerGlobalScope, private adapter: Adapter, private db: Database) {
    // Listen to fetch events.
    this.scope.addEventListener('fetch', (event) => this.onFetch(event!));
  }

  private onFetch(event: FetchEvent): void {
    // If the SW is in a broken state where it's not safe to handle requests at all, returning causes
    // the request to fall back on the network. This is preferred over `respondWith(fetch(req))` because
    // the latter still shows in DevTools that the request was handled by the SW.
    // TODO: try to handle DriverReadyState.EXISTING_CLIENTS_ONLY here.
    if (this.state === DriverReadyState.SAFE_MODE) {
      return;
    }

    // Past this point, the SW commits to handling the request itself. This could still fail (and result
    // in `state` being set to `SAFE_MODE`), but even in that case the SW will still deliver a response.
    event.respondWith(this.handleFetch(event));
  }

  private async handleFetch(event: FetchEvent): Promise<Response> {
    // Since the SW may have just been started, it may or may not have been initialized already.
    // this.initialized will be `null` if initialization has not yet been attempted, or will be a
    // Promise which will resolve (successfully or unsuccessfully) if it has.
    if (this.initialized === null) {
      // Initialization has not yet been attempted, so attempt it. This should only ever happen once
      // per SW instantiation.
      this.initialized = this.initialize();
    }

    // If initialization fails, the SW needs to enter a safe state, where it declines to respond to
    // network requests.
    try {
      // Wait for initialization.
      await this.initialized;
    } catch (_) {
      // Initialization failed. Enter a safe state.
      this.state = DriverReadyState.SAFE_MODE;
      // Since the SW is already committed to responding to the currently active request, 
      return this.scope.fetch(event.request);
    }

    // Decide which version of the app to use to serve this request.
    const appVersion = this.assignVersion(event);

    // Bail out
    if (appVersion === null) {
      return this.scope.fetch(event.request);
    }

    // Handle the request. First try the AppVersion. If that doesn't work, fall back on the network.
    const res = await appVersion.handleFetch(event.request, event);
    
    // The AppVersion will only return null if the manifest doesn't specify what to do about this
    // request. In that case, just fall back on the network.
    if (res === null) {
      return this.scope.fetch(event.request);
    }

    // The AppVersion returned a usable response, so return it.
    return res;
  }

  /**
   * Attempt to quickly reach a state where it's safe to serve responses.
   */
  private async initialize(): Promise<void> {
    // On initialization, all of the serialized state is read out of the 'control' table. This includes:
    // - map of hashes to manifests of currently loaded application versions
    // - map of client IDs to their pinned versions
    // - record of the most recently fetched manifest hash
    //
    // If these values don't exist in the DB, then this is the either the first time the SW has run or
    // the DB state has been wiped or is inconsistent. In that case, load a fresh copy of the manifest
    // and reset the state from scratch.

    // Open up the DB table.
    const table = await this.db.open('control');

    // Attempt to load the needed state from the DB. If this fails, the catch {} block will populate
    // these variables with freshly constructed values.
    let manifests: ManifestMap, assignments: ClientAssignments, latest: LatestEntry;
    try {
      // Read them from the DB simultaneously.
      [manifests, assignments, latest] = await Promise.all([
        table.read<ManifestMap>('manifests'),
        table.read<ClientAssignments>('assignments'),
        table.read<LatestEntry>('latest'),
      ]);
    } catch (_) {
      // Something went wrong. Try to start over by fetching a new manifest from the server and building
      // up an empty initial state.
      const manifest = await this.fetchLatestManifest();
      const hash = hashManifest(manifest);
      manifests = {};
      manifests[hash] = manifest;
      assignments = {};
      latest = {latest: hash};

      // Save the initial state to the DB.
      await Promise.all([
        table.write('manifests', manifests),
        table.write('assignments', assignments),
        table.write('latest', latest),
      ]);
    }

    // At this point, either the state has been loaded successfully, or fresh state with a new copy of
    // the manifest has been produced. At this point, the `Driver` can have its internals hydrated from
    // the state.

    // Initialize the `versions` map by setting each hash to a new `AppVersion` instance for that manifest.
    Object.keys(manifests).forEach((hash: ManifestHash) => {
      const manifest = manifests[hash];

      // If the manifest is newly initialized, an AppVersion may have already been created for it.
      if (!this.versions.has(hash)) {
        this.versions.set(hash, new AppVersion(this.scope, this.adapter, this.db, manifest, hash));
      }
    });

    // Wait for the scheduling of initialization of all versions in the manifest. Ordinarily this just
    // schedules the initializations to happen during the next idle period, but in development mode
    // this might actually wait for the full initialization.
    const eachInit = Object
      .keys(manifests)
      .map(async (hash: ManifestHash) => {
        try {
          // Attempt to schedule or initialize this version. If this operation is successful, then
          // initialization either succeeded or was scheduled. If it fails, then full initialization
          // was attempted and failed.
          await this.scheduleInitialization(this.versions.get(hash)!);
          return true;
        } catch (err) {
          return false;
        }
      });
    await Promise.all(eachInit);

    // Map each client ID to its associated hash. Along the way, verify that the hash is still valid
    // for that clinet ID. It should not be possible for a client to still be associated with a hash
    // that was since removed from the state.
    Object.keys(assignments).forEach((clientId: ClientId) => {
      const hash = assignments[clientId];
      if (!this.versions.has(hash)) {
        throw new Error(`Invariant violated (initialize): no manifest known for hash ${hash} active for client ${clientId}`);
      }
      this.clientVersionMap.set(clientId, hash);
    });

    // Set the latest version.
    this.latestHash = latest.latest;

    // Finally, assert that the latest version is in fact loaded.
    if (!this.versions.has(latest.latest)) {
      throw new Error(`Invariant violated (initialize): latest hash ${latest.latest} has no known manifest`);
    }
  }

  private lookupVersionByHash(hash: ManifestHash, debugName: string = 'lookupVersionByHash'): AppVersion {
    // The version should exist, but check just in case.
    if (!this.versions.has(hash)) {
      throw new Error(`Invariant violated (${debugName}): want AppVersion for ${hash} but not loaded`);
    }
    return this.versions.get(hash)!;
  }

  /**
   * Decide which version of the manifest to use for the event.
   */
  private assignVersion(event: FetchEvent): AppVersion|null {
    // First, check whether the event has a client ID. If it does, the version may already be associated.
    const clientId = event.clientId;
    if (clientId !== null) {
      // Check if there is an assigned client id.
      if (this.clientVersionMap.has(clientId)) {
        // There is an assignment for this client already.
        const hash = this.clientVersionMap.get(clientId)!;

        // TODO: make sure the version is valid.
        return this.lookupVersionByHash(hash, 'assignVersion');
      } else {
        // This is the first time this client ID has been seen. Whether the SW is in a state
        // to handle new clients depends on the current readiness state, so check that first.
        if (this.state !== DriverReadyState.NORMAL) {
          // It's not safe to serve new clients in the current state. It's possible that this
          // is an existing client which has not been mapped yet (see below) but even if that
          // is the case, it's invalid to make an assignment to a known invalid version, even
          // if that assignment was previously implicit. Return undefined here to let the
          // caller know that no assignment is possible at this time.
          return null;
        }
        
        // It's safe to handle this request. Two cases apply. Either:
        // 1) the browser assigned a client ID at the time of the navigation request, and
        //    this is truly the first time seeing this client, or
        // 2) a navigation request came previously from the same client, but with no client
        //    ID attached. Browsers do this to avoid creating a client under the origin in
        //    the event the navigation request is just redirected.
        //
        // In case 1, the latest version can safely be used.
        // In case 2, the latest version can be used, with the assumption that the previous
        // navigation request was answered under the same version. This assumption relies
        // on the fact that it's unlikely an update will come in between the navigation
        // request and requests for subsequent resources on that page.

        // First validate the current state.
        if (this.latestHash === null) {
          throw new Error(`Invariant violated (assignVersion): latestHash was null`);
        }

        // Pin this client ID to the current latest version, indefinitely.
        this.clientVersionMap.set(clientId, this.latestHash);
        // TODO: sync to DB.

        // Return the latest `AppVersion`.
        return this.lookupVersionByHash(this.latestHash, 'assignVersion');
      }
    } else {
      // No client ID was associated with the request. This must be a navigation request
      // for a new client. First check that the SW is accepting new clients.
      if (this.state !== DriverReadyState.NORMAL) {
        return null;
      }
      
      // Serve it with the latest version, and assume that the client will actually get
      // associated with that version on the next request.

      // First validate the current state.
      if (this.latestHash === null) {
        throw new Error(`Invariant violated (assignVersion): latestHash was null`)
      }

      // Return the latest `AppVersion`.
      return this.lookupVersionByHash(this.latestHash, 'assignVersion');
    }
  }

  /**
   * Retrieve a copy of the latest manifest from the server.
   */
  private async fetchLatestManifest(): Promise<Manifest> {
    const res = await this.scope.fetch('/ngsw.json?ngsw-cache-bust=' + Math.random());
    return res.json();
  }
  
  /**
   * Schedule the SW's attempt to reach a fully prefetched state for the given AppVersion
   * when the SW is not busy and has connectivity. This returns a Promise which must be
   * awaited, as under some conditions the AppVersion might be initialized immediately.
   */
  private async scheduleInitialization(appVersion: AppVersion): Promise<void> {
    const initialize = async () => {
      try {
        await appVersion.initializeFully();
      } catch (err) {
        this.versionFailed(appVersion, err);
      }
    };
    // TODO: better logic for detecting localhost.
    if (this.scope.registration.scope.indexOf('://localhost') > -1) {
      return initialize();
    }
    // TODO: schedule this to happen asynchronously.
    return initialize();
  }

  private versionFailed(appVersion: AppVersion, err: Error): void {
    // This particular AppVersion is broken. First, find the manifest hash.
    const broken = Array.from(this.versions.entries()).find(([hash, version]) => version === appVersion);
    if (broken === undefined) {
      // This version is no longer in use anyway, so nobody cares.
      return;
    }
    const brokenHash = broken[0];

    // TODO: notify affected apps.

    // The action taken depends on whether the broken manifest is the active (latest) or not.
    // If so, the SW cannot accept new clients, but can continue to service old ones.
    if (this.latestHash === brokenHash) {
      // The latest manifest is broken. This means that new clients are at the mercy of the
      // network, but caches continue to be valid for previous versions. This is unfortunate
      // but unavoidable.
      this.state =  DriverReadyState.EXISTING_CLIENTS_ONLY;
      
      // Cancel the binding for these clients.
      Array
        .from(this.clientVersionMap.keys())
        .forEach(clientId => this.clientVersionMap.delete(clientId));
    } else {
      // The current version is viable, but this older version isn't. The only possible remedy
      // is to stop serving the older version and go to the network. Figure out which clients
      // are affected and put them on the latest.
      const affectedClients = Array
        .from(this.clientVersionMap.keys())
        .filter(clientId => this.clientVersionMap.get(clientId)! === brokenHash);
      // Push the affected clients onto the latest version.
      affectedClients.forEach(clientId => this.clientVersionMap.set(clientId, this.latestHash!));
    }
  }

  private async setupUpdate(manifest: Manifest, hash: string): Promise<void> {
    const newVersion = new AppVersion(this.scope, this.adapter, this.db, manifest, hash);

    // Try to determine a version that's safe to update from.
    let updateFrom: AppVersion|undefined = undefined;

    // It's always safe to update from a version, even a broken one, as it will still only have
    // valid resources cached. If there is no latest version, though, this update will have to 
    if (this.latestHash !== null) {
      updateFrom = this.versions.get(this.latestHash);
    }

    // Cause the new version to become fully initialized. If this fails, then the version will
    // not be available for use.
    await newVersion.initializeFully(this);

    // Install this as an active version of the app.
    this.versions.set(hash, newVersion);
    await this.sync();

    // Future new clients will use this hash as the latest version.
    this.latestHash = hash;

    // TODO: notify applications about the newly active update.
  }

  private async checkForUpdate(): Promise<boolean> {
    const manifest = await this.fetchLatestManifest();
    const hash = hashManifest(manifest);

    // Check whether this is really an update.
    if (this.versions.has(hash)) {
      return false;
    }

    await this.setupUpdate(manifest, hash);
    return true;
  }

  sync(): void {

  }

  /**
   * Determine if a specific version of the given resource is cached anywhere within the SW,
   * and fetch it if so.
   */
  lookupResourceWithHash(url: string, hash: string): Promise<Response|null> {
    return Array
      // Scan through the set of all cached versions, valid or otherwise. It's safe to do such
      // lookups even for invalid versions as the cached version of a resource will have the
      // same hash regardless.
      .from(this.versions.values())
      // Reduce the set of versions to a single potential result. At any point along the
      // reduction, if a response has already been identified, then pass it through, as no
      // future operation could change the response. If no response has been found yet, keep
      // checking versions until one is or until all versions have been exhausted.
      .reduce(async (prev, version) => {
        // First, check the previous result. If a non-null result has been found already, just
        // return it.
        if (await prev !== null) {
          return prev;
        }

        // No result has been found yet. Try the next `AppVersion`.
        return version.lookupResourceWithHash(url, hash);
      }, Promise.resolve<Response|null>(null))
  }
}
