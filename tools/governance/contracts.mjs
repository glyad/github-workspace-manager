/** @typedef {{source:string,actorId:string,observedAt:string,resourceId:string,revision?:string,digest?:string}} Evidence */
/** @template T @typedef {{kind:'verified',value:T,evidence:Evidence[]}|{kind:'blocked'|'conflict'|'uncertain',reason:string,evidence:Evidence[]}} Result */
/** @typedef {{host:string,actor:{login:string,id:string},protocol:string,repository:{exists:boolean,fullName:string,id:?string},destination:{path:string,state:string,safeAncestors:boolean},signing:{localVerified:boolean,githubAssociationVerified:boolean,fingerprint?:string},project:{authorized:boolean,scopeVerified:boolean,matches:object[]},rules:{supported:boolean,revision:string,effective:object[]},evidence:Evidence[]}} SetupSnapshot */
/** @typedef {{operationId:string,repositoryId:string,fullName:string,actor:object,destination:string,snapshot:SetupSnapshot,beforeRules:object,desiredRules:object,approvedPaths:string[],approvedOperations:string[],startedAt:string,endedAt:?string,state:'open'|'closed',ordinaryWorkAllowed:false,outstandingWork:string[]}} SetupSession */
/** @typedef {{repositoryId:string,verified:boolean,observed:object,ordinaryWorkAllowed:false}} ProtectionEvidence */
/** @typedef {{operationId:string,repositoryId?:string,fullName?:string,phase:string,evidence?:Evidence[]}} SetupJournalRecord */
/** @typedef {(key:string,record:SetupJournalRecord)=>Promise<Result<SetupJournalRecord>>} AppendSetupJournal */
/** @typedef {(key:string)=>Promise<Result<SetupJournalRecord[]>>} ReadSetupJournal */
/** @typedef {{operationId:string,fullName:string,actorId:string}} RepositoryCreationOperation */
/** @template T @param {T} value @param {Evidence[]} evidence @returns {Result<T>} */
export const verified = (value, evidence = []) => ({ kind: 'verified', value, evidence });
/** @param {string} reason @param {Evidence[]} evidence @returns {Result<never>} */
export const blocked = (reason, evidence = []) => ({ kind: 'blocked', reason, evidence });

/** Legacy candidates are historical identities; v2 carries the deliberate request and base ref. */
export const legacyCandidateFields = ['repositoryId', 'pr', 'base', 'head', 'attempt'];
export const v2CandidateFields = [
  ...legacyCandidateFields,
  'baseRef',
  'requestId',
  'protocolVersion',
];
export const requestFields = [
  'protocolVersion',
  'requestId',
  'repositoryId',
  'pr',
  'prNodeId',
  'baseRef',
  'base',
  'head',
  'initiatingActorId',
  'originalRunId',
  'workflowId',
  'definitionSha',
];
export const exactFields = (value, fields) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === fields.length &&
  fields.every((k) => Object.hasOwn(value, k));
export const boundedId = (value) =>
  typeof value === 'string' &&
  Buffer.byteLength(value) >= 1 &&
  Buffer.byteLength(value) <= 128 &&
  !/[\x00-\x1f\x7f]/.test(value);
export const sha40 = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export const requestId = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export function validBaseRef(value) {
  return (
    typeof value === 'string' &&
    Buffer.byteLength(value) <= 255 &&
    value.startsWith('refs/heads/') &&
    !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) &&
    !value.includes('..') &&
    !value.includes('@{') &&
    !value.endsWith('.') &&
    value
      .slice(11)
      .split('/')
      .every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'))
  );
}
export function validCandidate(value) {
  const v2 = value?.protocolVersion === 2;
  return (
    exactFields(value, v2 ? v2CandidateFields : legacyCandidateFields) &&
    boundedId(value.repositoryId) &&
    Number.isSafeInteger(value.pr) &&
    value.pr > 0 &&
    sha40(value.base) &&
    sha40(value.head) &&
    requestId(value.attempt) &&
    (!v2 || (validBaseRef(value.baseRef) && requestId(value.requestId)))
  );
}
export function validReadinessRequest(value) {
  return (
    exactFields(value, requestFields) &&
    value.protocolVersion === 2 &&
    requestId(value.requestId) &&
    ['repositoryId', 'prNodeId', 'initiatingActorId', 'originalRunId', 'workflowId'].every((k) =>
      boundedId(value[k]),
    ) &&
    Number.isSafeInteger(value.pr) &&
    value.pr > 0 &&
    validBaseRef(value.baseRef) &&
    sha40(value.base) &&
    sha40(value.head) &&
    sha40(value.definitionSha)
  );
}
