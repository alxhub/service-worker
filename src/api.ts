export interface UpdateSource {
  lookupResourceWithHash(url: string, hash: string): Promise<Response|null>;
  lookupResourceWithoutHash(url: string): Promise<CacheState|null>;
  previouslyCachedResources(): Promise<string[]>;
}

export interface UrlMetadata {
  ts: number;
}

export interface CacheState {
  response: Response;
  metadata?: UrlMetadata;
}