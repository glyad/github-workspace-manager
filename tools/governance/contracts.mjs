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
