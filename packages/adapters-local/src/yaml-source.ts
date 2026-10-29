import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import {
  boundedJson,
  configurationFailure,
  configurationLimits,
  decodeConfiguration,
  decodeConfigurationSource,
} from '../../domain/src/configuration.js';
import type { Configuration } from '../../domain/src/configuration.js';
import type { ConfigurationSourceReader } from '../../application/src/configuration-sources.js';
import type { Json, Result, Revision, Source } from '../../domain/src/records.js';
/** Parse data only: no custom tags, aliases, merge keys, or executable contributions. */
export function parseConfiguration(yaml: string, source: Source): Result<Configuration> {
  try {
    if (
      typeof yaml !== 'string' ||
      yaml.length > configurationLimits.bytes ||
      new TextEncoder().encode(yaml).length > configurationLimits.bytes
    )
      return configurationFailure('CONFIGURATION_LIMIT');
    const document = parseDocument(yaml, {
      version: '1.2',
      uniqueKeys: true,
      strict: true,
      resolveKnownTags: false,
      customTags: [],
      merge: false,
    });
    if (
      document.errors.length ||
      document.warnings.length ||
      document.directives?.yaml.version !== '1.2'
    )
      return configurationFailure('INVALID_YAML');
    let nodes = 0;
    function read(node: unknown, depth: number): Json {
      if (++nodes > configurationLimits.nodes || depth > configurationLimits.depth)
        throw new Error('CONFIGURATION_LIMIT');
      if (node === null) return null;
      if (isAlias(node)) throw new Error('INVALID_YAML');
      if (isScalar(node)) {
        if (
          node.tag &&
          ![
            'tag:yaml.org,2002:str',
            'tag:yaml.org,2002:bool',
            'tag:yaml.org,2002:int',
            'tag:yaml.org,2002:float',
            'tag:yaml.org,2002:null',
          ].includes(node.tag)
        )
          throw new Error('INVALID_YAML');
        return boundedJson(node.value);
      }
      if (isSeq(node)) return node.items.map((item) => read(item, depth + 1));
      if (isMap(node)) {
        const result: Record<string, Json> = {};
        for (const pair of node.items) {
          if (
            !isScalar(pair.key) ||
            typeof pair.key.value !== 'string' ||
            ['__proto__', 'constructor', 'prototype', '<<'].includes(pair.key.value) ||
            Object.hasOwn(result, pair.key.value)
          )
            throw new Error('INVALID_YAML');
          result[pair.key.value] = read(pair.value, depth + 1);
        }
        return result;
      }
      throw new Error('INVALID_YAML');
    }
    return decodeConfiguration(read(document.contents, 0), source);
  } catch {
    return configurationFailure('INVALID_YAML');
  }
}
export function yamlSourceReader(
  readCommitted: (source: Source) => Promise<{ bytes: Uint8Array; revision: Revision }>,
): ConfigurationSourceReader {
  return {
    async read(source) {
      const pinned = decodeConfigurationSource(source);
      if (!pinned.ok) return pinned;
      try {
        // The injected port verifies ref→revision mapping. Its argument cannot rewrite provenance.
        const read = await readCommitted(structuredClone(pinned.value));
        if (read.revision !== pinned.value.revision)
          return configurationFailure('SOURCE_REVISION_CHANGED');
        if (
          !(read.bytes instanceof Uint8Array) ||
          read.bytes.byteLength > configurationLimits.bytes
        )
          return configurationFailure('CONFIGURATION_LIMIT');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes);
        const configuration = parseConfiguration(text, pinned.value);
        return configuration.ok
          ? {
              ok: true,
              value: { source: structuredClone(pinned.value), configuration: configuration.value },
            }
          : configuration;
      } catch {
        return configurationFailure('SOURCE_UNAVAILABLE');
      }
    },
  };
}
