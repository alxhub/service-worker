import {Context} from './adapter';
import {Manifest} from './manifest';

import {AssetGroup} from './assets';

export class AppVersion {
  private hashes = new Map<string, string>();
  private assetGroups: AssetGroup[];

  constructor(private manifest: Manifest) {
  }

  initializeFully(): Promise<void> {
    return null!;
  }

  handleFetch(req: Request, context: Context): Promise<Response|null> {
    return null!;
  }
}