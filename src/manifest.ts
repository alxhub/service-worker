export type ManifestHash = string;

export interface Manifest {
  configVersion: number;
  appData?: Object;
  assetGroups?: AssetGroup[];
  dataGroups?: DataGroup[];
  hashTable: Object;
}

export interface AssetGroup {
  name: string;
  urls: string[];
  patterns: string[];
}

export interface DataGroup {
  name: string;
}

export function hashManifest(manifest: Manifest): ManifestHash {
  return null!;
}