export type ManifestHash = string;

export interface Manifest {
  configVersion: number;
  appData?: Object;
  assetGroups?: AssetGroupConfig[];
  dataGroups?: DataGroupConfig[];
  hashTable: Object;
}

export interface AssetGroupConfig {
  name: string;
  urls: string[];
  patterns: string[];
}

export interface DataGroupConfig {
  name: string;
}

export function hashManifest(manifest: Manifest): ManifestHash {
  return null!;
}