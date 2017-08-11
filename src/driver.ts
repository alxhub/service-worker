import {Adapter} from './adapter';
import {AppVersion} from './app-version';
import {Database, Table} from './db';
import {Manifest, ManifestHash, hashManifest} from './manifest';

type ClientId = string;

type ManifestMap = {[hash: string]: Manifest};
type ClientAssignments = {[id: string]: ManifestHash};

interface LatestEntry {
  latest: string;
}

export class Driver {

  /**
   * Tracks whether the SW is in an initialized state or not. Before initialization, it's not legal to
   * respond to requests.
   */
  private initialized: Promise<void>|null = null;

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
  latestHash: ManifestHash|null = null;

  constructor(private scope: ServiceWorkerGlobalScope, private adapter: Adapter, private db: Database) {
    // Listen to fetch events.
    this.scope.addEventListener('fetch', (event) => this.handleFetch(event!));
  }

  private handleFetch(event: FetchEvent): void {
    // The first request causes SW initialization. Every other request will wait on that initialization.
    // This happens every SW start, so it needs to be reasonably fast.
    if (this.initialized === null) {
      this.initialized = this.initialize();
    }
  }

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
    // the manifest has been achieved. At this point, the `Driver` can have its internals hydrated from
    // the state.

    // Map each hash to a new `AppVersion` instance for that manifest.
    Object.keys(manifests).forEach((hash: ManifestHash) => {
      const manifest = manifests[hash];
      this.versions.set(hash, new AppVersion(manifest)); 
    });

    /**
     * Map each client ID to its associated hash. Along the way, verify that the hash is still valid
     * for that clinet ID. It should not be possible for a client to still be associated with a hash
     * that was since removed from the state.
     */
    Object.keys(assignments).forEach((clientId: ClientId) => {
      const hash = assignments[clientId];
      if (!this.versions.has(hash)) {
        throw new Error(`Invariant violated (initialize): no manifest known for hash ${hash} active for client ${clientId}`);
      }
      this.clientVersionMap.set(clientId, hash);
    });
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
  // TODO: make this not a Promise.
  private assignVersion(event: FetchEvent): Promise<AppVersion> {
    // First, check whether the event has a client ID. If it does, the version may already be associated.
    const clientId = event.clientId;
    if (clientId !== null) {
      // Check if there is an assigned client id.
      if (this.clientVersionMap.has(clientId)) {
        // There is an assignment for this client already.
        const hash = this.clientVersionMap.get(clientId)!;

        // TODO: make sure the version is valid.
        return Promise.resolve(this.lookupVersionByHash(hash, 'assignVersion'));
      } else {
        // This is the first time this client ID has been seen. Two cases apply. Either:
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
          throw new Error(`Invariant violated (assignVersion): latestHash was null`)
        }

        // Pin this client ID to the current latest version, indefinitely.
        this.clientVersionMap.set(clientId, this.latestHash);
        // TODO: sync to DB.

        // Return the latest `AppVersion`.
        return Promise.resolve(this.lookupVersionByHash(this.latestHash, 'assignVersion'));
      }
    } else {
      // No client ID was associated with the request. This must be a navigation request
      // for a new client. Serve it with the latest version, and assume that the client
      // will actually get associated with that version on the next request.

      // First validate the current state.
      if (this.latestHash === null) {
        throw new Error(`Invariant violated (assignVersion): latestHash was null`)
      }

      // Return the latest `AppVersion`.
      return Promise.resolve(this.lookupVersionByHash(this.latestHash, 'assignVersion'));
    }
  }

  private fetchLatestManifest(): Promise<Manifest> {
    return null!;
  }
}
