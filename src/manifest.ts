import {sha1} from './sha1';

export type ManifestHash = string;

export interface Manifest {
  configVersion: number;
  appData?: {[key: string]: string};
  assetGroups?: AssetGroupConfig[];
  dataGroups?: DataGroupConfig[];
  hashTable: {[url: string]: string};
}

export interface AssetGroupConfig {
  name: string;
  mode: 'prefetch'|'lazy';
  urls: string[];
  patterns: string[];
}

export interface DataGroupConfig {
  name: string;
  patterns: string[];
}

export function hashManifest(manifest: Manifest): ManifestHash {
  return sha1(JSON.stringify(manifest));
}