import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Digest, Json, Resource } from './records.js';

/** Repository coordinates only. Local paths are not GitHub identity fields. */
export function resourceKey(resource: Resource): string {
  if (
    typeof resource.host !== 'string' ||
    resource.host.length > 253 ||
    !resource.host
      .split('.')
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
    typeof resource.owner !== 'string' ||
    !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(resource.owner) ||
    typeof resource.name !== 'string' ||
    !/^[a-z0-9_.-]{1,100}$/i.test(resource.name) ||
    resource.name === '.' ||
    resource.name === '..'
  ) {
    throw new Error('INVALID_RESOURCE_IDENTITY');
  }
  return JSON.stringify([
    resource.host.toLowerCase(),
    resource.owner.toLowerCase(),
    resource.name.toLowerCase(),
  ]);
}

/** Canonical JSON: lexicographic UTF-16 keys, JSON string/number spelling, UTF-8 SHA-256. */
export function canonicalDigest(value: Json): Digest {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalJson(value))));
}
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(input: unknown): string {
    if (input === null) return 'null';
    if (typeof input === 'boolean' || typeof input === 'string') return JSON.stringify(input);
    if (typeof input === 'number' && Number.isFinite(input)) return JSON.stringify(input);
    if (typeof input !== 'object' || input === null || ancestors.has(input))
      throw new Error('INVALID_JSON');
    const prototype: unknown = Object.getPrototypeOf(input);
    if (!Array.isArray(input) && prototype !== Object.prototype && prototype !== null)
      throw new Error('INVALID_JSON');
    if (Object.getOwnPropertySymbols(input).length) throw new Error('INVALID_JSON');
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        if (Object.keys(input).length !== input.length) throw new Error('INVALID_JSON');
        return (
          '[' +
          Array.from({ length: input.length }, (_, i) => {
            const descriptor = Object.getOwnPropertyDescriptor(input, String(i));
            if (!descriptor || !('value' in descriptor)) throw new Error('INVALID_JSON');
            return encode(descriptor.value);
          }).join(',') +
          ']'
        );
      }
      return (
        '{' +
        Object.keys(input)
          .sort()
          .map((key) => {
            const descriptor = Object.getOwnPropertyDescriptor(input, key);
            if (!descriptor || !('value' in descriptor)) throw new Error('INVALID_JSON');
            return JSON.stringify(key) + ':' + encode(descriptor.value);
          })
          .join(',') +
        '}'
      );
    } finally {
      ancestors.delete(input);
    }
  }
  return encode(value);
}
