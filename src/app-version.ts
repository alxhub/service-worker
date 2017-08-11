import {Manifest} from './manifest';

export class AppVersion {
  constructor(private manifest: Manifest) {}

  handleFetch(req: Request): Promise<Response|null> {
    return null!;
  }
}