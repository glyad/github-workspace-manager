import { configurationFailure, decodeConfigurationSource } from '../../domain/src/configuration.js';
import type { Configuration } from '../../domain/src/configuration.js';
import type { Result, Source } from '../../domain/src/records.js';
export interface ConfigurationSourceReader {
  read(source: Source): Promise<Result<{ source: Source; configuration: Configuration }>>;
}
/** Personal defaults require an identified repository source; no implicit repository creation. */
export function selectSource(
  ownerKind: 'personal' | 'organization',
  explicit: Source | undefined,
  central: Source | undefined,
): Result<Source> {
  if (ownerKind !== 'personal' && ownerKind !== 'organization')
    return configurationFailure('INVALID_SOURCE');
  const selected = explicit ?? (ownerKind === 'organization' ? central : undefined);
  if (!selected) return configurationFailure('SOURCE_REQUIRED');
  const result = decodeConfigurationSource(selected);
  if (result.ok && !explicit && result.value.kind !== 'central')
    return configurationFailure('INVALID_SOURCE');
  return result;
}
