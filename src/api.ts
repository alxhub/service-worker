export interface UpdateSource {
  lookupResourceWithHash(url: string, hash: string): Promise<Response|null>;
}