import type {
  Id,
  Artifact,
  Event,
  Resource,
  Capability,
  ProviderResult,
  Observation,
  Operation,
  Evidence,
  Decision,
  Result,
  Authorization,
} from './records.js';
export interface StateStore {
  read<T>(key: string): Promise<T | undefined>;
  write<T>(key: string, value: T): Promise<void>;
}
export interface ArtifactStore {
  put(bytes: Uint8Array, mediaType: string): Promise<Artifact>;
  get(ref: Artifact): Promise<Uint8Array>;
}
export interface Audit {
  append(event: Omit<Event, 'sequence'>): Promise<Event>;
  read(): Promise<readonly Event[]>;
}
export interface Lease {
  release(): Promise<void>;
}
export interface Locks {
  acquire(keys: readonly string[], runId: Id): Promise<Lease>;
}
export interface Provider {
  readonly id: Id;
  discover(resource: Resource): Promise<Capability>;
  observe(resource: Resource): Promise<ProviderResult<Observation>>;
  dispatch(operation: Operation, signal: AbortSignal): Promise<ProviderResult<Evidence>>;
}
export interface ConsentChannel {
  accept(decision: Decision): Promise<Result<Authorization>>;
}
export interface Clock {
  now(): string;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}
