import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Artifact, Digest, FieldPath, Json } from './records.js';

export type Component = {
  id: string;
  schema: Json;
  prerequisites: string[];
  permissions: string[];
  ownedFields: FieldPath[];
  actions: string[];
  backupFields: FieldPath[];
  costTriggers: string[];
  reversalLimits: string[];
};
export type FileChange = { path: string; beforeDigest?: Digest; after?: Artifact };
/** Artifact digests hash raw bytes; semantic canonical JSON digests remain separate. */
export function artifactDigest(bytes: Uint8Array): Digest {
  return bytesToHex(sha256(bytes));
}
