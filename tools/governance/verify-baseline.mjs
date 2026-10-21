import { isEvidenceFor } from './validate.mjs';

/**
 * Trusted read-only port extension: observeBaseline(repositoryId) -> Result<BaselineObservation>.
 * The adapter must fetch complete effective main/develop rules (including inherited
 * and classic protection), matching ruleset details/bypass lists, ref/signature and
 * Project/security/Actions readbacks. Observation booleans are conclusions of that
 * trusted adapter with retained source responses, never accepted from Issue content.
 * Expected IDs/SHAs come from the frozen setup manifest, not the response being checked.
 * No remote adapter or activation authority is supplied by this pure verification module.
 */
export async function verifyBaseline(port, expected) {
  const components = {};
  const evidence = [];
  const report = {
    repositoryId: expected?.repositoryId,
    components,
    baselineComplete: false,
    restorationVerified: false,
    ordinaryDraftWorkAllowed: false,
    ordinaryIntegrationAllowed: false,
    releaseAllowed: false,
    actionsActivationAllowed: false,
    enforcementBoundary:
      'Native rules cannot restrict every main direct push to a develop source. Maintainer-authorized release adapter ancestry/tree checks remain required; release automation is inactive.',
  };
  const fail = (reason, kind = 'blocked') => ({ kind, reason, value: report, evidence });
  if (
    !expected?.repositoryId ||
    !expected.actorId ||
    !expected.projectId ||
    !expected.setupOperationId ||
    ![expected.mainSha, expected.developSha].every((sha) => /^[0-9a-f]{40}$/.test(sha ?? '')) ||
    (expected.phase !== undefined && expected.phase !== 'restoration')
  )
    return fail('Frozen setup identity, SHAs and supported verification phase required');
  let result;
  try {
    result = await port.observeBaseline(expected.repositoryId);
  } catch {
    return fail('Baseline observation unavailable; reconcile without mutation', 'uncertain');
  }
  if (result?.kind !== 'verified')
    return fail(
      result?.reason ?? 'Baseline observation unverified',
      ['blocked', 'conflict', 'uncertain'].includes(result?.kind) ? result.kind : 'blocked',
    );
  if (!isEvidenceFor(result.evidence, expected.actorId, [expected.repositoryId]))
    return fail('Baseline evidence actor, resource or freshness mismatch');
  evidence.push(...result.evidence);
  const v = result.value;
  const add = (name, okay, blocker, nextGate) => {
    components[name] = {
      status: okay ? 'verified' : 'blocked',
      ...(okay ? {} : { blocker, nextGate }),
    };
  };
  const r = v?.repository;
  add(
    'repository',
    r?.id === expected.repositoryId &&
      r.fullName === 'glyad/github-workspace-manager' &&
      r.visibility === 'public' &&
      r.defaultBranch === 'main' &&
      r.allowMergeCommit === true &&
      ['allowSquashMerge', 'allowRebaseMerge', 'allowAutoMerge', 'deleteBranchOnMerge'].every(
        (key) => r[key] === false,
      ),
    'Repository identity or merge settings differ',
    'Read back selected repository settings',
  );
  add(
    'project',
    v?.project?.id === expected.projectId &&
      v.project.public === true &&
      v.project.verified === true,
    'Project baseline identity/visibility incomplete',
    'Verify Task 3 evidence',
  );
  add(
    'ruleInventory',
    v?.rulesInventoryComplete === true &&
      Array.isArray(v.rulesets) &&
      v.rulesets.length > 0 &&
      v.rulesets.every(
        (s) =>
          s.id &&
          ['active', 'disabled', 'evaluate'].includes(s.enforcement) &&
          Array.isArray(s.bypass_actors) &&
          s.bypass_actors.length === 0,
      ) &&
      Array.isArray(v.inheritedConflicts) &&
      v.inheritedConflicts.length === 0,
    'Missing complete effective rules/bypass inventory or inherited conflict',
    'Read all matching inherited, repository and classic protections; reconcile conflicts',
  );
  add(
    'bypassRemoval',
    v?.temporaryBypassAbsent === true && v.releaseBypassAbsent === true,
    'Temporary or release bypass remains/unverified',
    'Remove temporary bypass and read back; release grants remain inactive',
  );
  const mainRules = v?.branches?.main?.rules;
  const developRules = v?.branches?.develop?.rules;
  const exactTypes = (rules, types) =>
    Array.isArray(rules) &&
    types.every((type) => rules.some((x) => x.type === type)) &&
    rules.every((x) => types.includes(x.type));
  add(
    'mainProtections',
    exactTypes(mainRules, ['required_signatures', 'non_fast_forward', 'deletion']),
    'Main signed/force-push/deletion safeguards missing or conflicting main PR/linear rule',
    'Restore selected main safeguards without main PR/linear history',
  );
  const prs = Array.isArray(developRules)
    ? developRules.filter((x) => x.type === 'pull_request')
    : [];
  add(
    'developProtections',
    exactTypes(developRules, [
      'required_signatures',
      'non_fast_forward',
      'deletion',
      'update',
      'pull_request',
    ]) &&
      prs.every(
        (p) =>
          p.parameters?.required_approving_review_count === 0 &&
          p.parameters.required_review_thread_resolution === true &&
          p.parameters.require_code_owner_review !== true &&
          p.parameters.require_last_push_approval !== true,
      ) &&
      developRules
        ?.filter((x) => x.type === 'update')
        .every((x) => x.parameters?.update_allows_fetch_and_merge !== true),
    'Develop safeguards or deny-update gate missing; unverified required check or unavailable human approval configured',
    'Keep deny-update with empty bypass until Tasks 6–7 prove real checks and reviewer gates',
  );
  add(
    'signedBaseline',
    v?.branches?.main?.sha === expected.mainSha &&
      v.branches.develop?.sha === expected.developSha &&
      v.branches.main.signatureVerified === true &&
      v.branches.develop.signatureVerified === true &&
      v.developContainsFinalMain === true &&
      v.localChecks?.passed === true &&
      v.localChecks.command === 'npm run check:local' &&
      v.localChecks.sha === expected.developSha &&
      v.localChecks.mainSha === expected.mainSha,
    'Final refs/signatures/ancestry or matching local validation unverified',
    'Fetch both refs, signed literal synchronization, verify ancestry and rerun local checks',
  );
  const route = v?.routing;
  add(
    'releaseRouting',
    route?.mainPRRequired === false &&
      route.releaseSource === 'develop' &&
      route.authority === 'glyad' &&
      route.nativeSourceRestriction === false &&
      route.adapterActive === false &&
      route.releaseBlocked === true,
    'Release routing boundary or inactive release adapter unverified',
    'Record maintainer-only develop ancestry/tree release checks; no native source restriction claim',
  );
  const a = v?.activation;
  add(
    'inactiveAutomation',
    a?.ordinaryIntegration === 'blocked' &&
      ['hostedCI', 'hostedReviewer', 'release', 'developRenewal'].every(
        (key) => a[key] === 'inactive',
      ) &&
      a.paidReviewApproved === false &&
      a.releaseIdentityApproved === false,
    'Automation activation is outside baseline authority',
    'Retain inactive reviewer/release/renewal and blocked integration',
  );
  const actions = v?.actions;
  // Disabled execution is the baseline admission gate. An omitted policy is
  // observed as null, never as a selected allowlist or verified SHA pinning.
  const policyShapeValid =
    typeof actions?.shaPinningRequired === 'boolean' &&
    (actions.allowedActions === 'selected'
      ? typeof actions.githubOwnedAllowed === 'boolean' &&
        typeof actions.verifiedAllowed === 'boolean' &&
        Array.isArray(actions.patternsAllowed) &&
        actions.patternsAllowed.every((pattern) => typeof pattern === 'string')
      : ['all', 'local_only', null].includes(actions.allowedActions) &&
        actions.allowlistConfigured === false &&
        actions.githubOwnedAllowed === null &&
        actions.verifiedAllowed === null &&
        actions.patternsAllowed === null);
  add(
    'actions',
    actions?.enabled === false &&
      actions.defaultWorkflowPermissions === 'read' &&
      actions.canApprovePullRequestReviews === false &&
      policyShapeValid &&
      actions.forkExecutionAdmitted === false,
    'Actions execution disablement, least privilege or policy observation unverified',
    'Read back disabled execution, read-only defaults, no PR approval and a typed policy observation',
  );
  const policyVerified =
    policyShapeValid &&
    actions.allowedActions === 'selected' &&
    actions.githubOwnedAllowed === false &&
    actions.verifiedAllowed === false &&
    actions.patternsAllowed.length === 0 &&
    actions.shaPinningRequired === true;
  components.actionsPolicy = {
    status: policyVerified ? 'verified' : 'pending-activation',
    observed: {
      allowedActions: actions?.allowedActions ?? null,
      shaPinningRequired: actions?.shaPinningRequired ?? null,
      allowlistConfigured: actions?.allowlistConfigured ?? actions?.allowedActions === 'selected',
    },
    nextGate:
      'Task 7 must configure and read back selected reviewed required immutable Actions and SHA pinning before ANY execution enablement; never temporarily enable during baseline setup',
  };
  for (const name of [
    'vulnerabilityAlerts',
    'secretScanning',
    'pushProtection',
    'privateVulnerabilityReporting',
  ]) {
    const s = v?.security?.[name];
    if (
      s?.status === 'unsupported' &&
      s.capability === 'unsupported' &&
      typeof s.reason === 'string' &&
      s.reason.length > 0
    )
      components[name] = {
        status: 'unsupported',
        blocker: s.reason,
        nextGate: 'Recheck free capability before enabling; no paid purchase authorized',
      };
    else
      add(
        name,
        s?.status === 'enabled' && s.capability === 'available',
        'Selected available security setting unverified',
        'Enable free supported setting and reread effective state',
      );
  }
  // A baseline has no trusted hosted worker yet. Never equate configuration with a real scan.
  const scanning = v?.codeScanning;
  components.codeScanning = {
    status: 'blocked',
    blocker: scanning?.reason ?? 'Meaningful real scanning run pending',
    nextGate:
      'Review safe supported configuration and prove a real meaningful scan under admitted triggers',
  };
  add(
    'scanningCapability',
    scanning?.status === 'pending' &&
      typeof scanning.configured === 'boolean' &&
      typeof scanning.reason === 'string' &&
      scanning.reason.length > 0,
    'Code-scanning capability/configuration status missing',
    'Record supported configuration or explicit trust/dependency blocker; do not invent a successful scan',
  );
  const session = v?.session;
  add(
    'sessionIdentity',
    session?.operationId === expected.setupOperationId,
    'Wrong setup session',
    'Reconcile frozen setup operation',
  );
  if (expected.phase !== 'restoration')
    add(
      'sessionClosure',
      session?.state === 'closed' &&
        session.closureRecordVerified === true &&
        session.remoteClosureRecordVerified === true,
      'Durable local/remote closure readback unverified',
      'Close only after final sync/restoration and retain local/remote closure without reopening main',
    );
  const blockers = Object.entries(components).filter(
    ([name, item]) => name !== 'codeScanning' && item.status === 'blocked',
  );
  if (blockers.length)
    return fail(`Baseline blocked: ${blockers.map(([name]) => name).join(', ')}`);
  report.restorationVerified = true;
  report.baselineComplete = expected.phase !== 'restoration';
  report.ordinaryDraftWorkAllowed = report.baselineComplete;
  return { kind: 'verified', value: report, evidence };
}

/**
 * Compose actual GitHub controls/commit observations with trusted Task 3 Project
 * and Task 1 closure observers. The latter must return fresh Result evidence for
 * the exact Project and setup-operation/ledger Issue; no invented IDs or success.
 * Local checks execute only on the selected actual checkout and matching final tree.
 */
export async function createBaselineGitHubPort({
  expected,
  execute,
  observeProjectBaseline,
  observeClosure,
}) {
  const { createProtectionGitHubPort } = await import('./protections.mjs');
  const { execFileSync } = await import('node:child_process');
  const { readFile } = await import('node:fs/promises');
  const root = '/Users/davidkossoglyad/Documents/GitHub/glyad/github-workspace-manager';
  const run =
    execute ??
    ((binary, args, options = {}) => {
      try {
        return {
          ok: true,
          stdout: execFileSync(binary, args, {
            encoding: 'utf8',
            timeout: 300_000,
            maxBuffer: 4_000_000,
            stdio: ['pipe', 'pipe', 'pipe'],
            ...options,
          }),
        };
      } catch (error) {
        return { ok: false, stdout: typeof error.stdout === 'string' ? error.stdout : '' };
      }
    });
  const controls = createProtectionGitHubPort({
    repositoryId: expected.repositoryId,
    actorId: expected.actorId,
    execute: run,
  });
  return {
    async observeBaseline(repositoryId) {
      const stop = (reason) => ({ kind: 'blocked', reason, evidence: [] });
      if (
        repositoryId !== expected.repositoryId ||
        typeof observeProjectBaseline !== 'function' ||
        typeof observeClosure !== 'function'
      )
        return stop('Exact identity and trusted Project/closure observers required');
      const observed = await controls.observeControls();
      if (observed.kind !== 'verified') return observed;
      const refs = await controls.observeRefs();
      if (refs.kind !== 'verified') return refs;
      const project = await observeProjectBaseline();
      if (
        project?.kind !== 'verified' ||
        !isEvidenceFor(project.evidence, expected.actorId, [expected.projectId]) ||
        project.value?.id !== expected.projectId ||
        project.value.public !== true ||
        project.value.verified !== true
      )
        return stop('Fresh complete Task 3 Project readback required');
      const closure = await observeClosure();
      if (
        closure?.kind !== 'verified' ||
        !isEvidenceFor(
          closure.evidence,
          expected.actorId,
          [expected.setupOperationId, expected.closureIssueId].filter(Boolean),
        ) ||
        closure.value?.operationId !== expected.setupOperationId
      )
        return stop('Trusted exact setup closure observation required');
      if (
        expected.phase !== 'restoration' &&
        (!expected.closureIssueId ||
          !closure.evidence.some((e) => e.resourceId === expected.closureIssueId) ||
          !closure.evidence.some((e) => e.resourceId === expected.setupOperationId))
      )
        return stop(
          'Final closure requires both actual local-operation and remote ledger Issue evidence',
        );
      const git = (...args) => run('git', ['-C', root, ...args]);
      const cleanBefore = git('status', '--porcelain=v1', '--untracked-files=all');
      const headBefore = git('rev-parse', 'HEAD');
      if (
        !cleanBefore.ok ||
        cleanBefore.stdout !== '' ||
        !headBefore.ok ||
        ![expected.mainSha, expected.developSha].includes(headBefore.stdout.trim())
      )
        return stop('Local candidate worktree/index is dirty or HEAD differs');
      let activation;
      try {
        activation = JSON.parse(await readFile(`${root}/governance/activation.json`, 'utf8'));
      } catch {
        return stop('Actual activation config unreadable');
      }
      const headTree = git('rev-parse', 'HEAD^{tree}');
      const developTree = git('rev-parse', `${expected.developSha}^{tree}`);
      const mainTree = git('rev-parse', `${expected.mainSha}^{tree}`);
      const sameTree =
        headTree.ok &&
        developTree.ok &&
        mainTree.ok &&
        headTree.stdout.trim() === developTree.stdout.trim() &&
        developTree.stdout.trim() === mainTree.stdout.trim();
      const ancestry = git('merge-base', '--is-ancestor', expected.mainSha, expected.developSha);
      const localSignatures =
        git('verify-commit', expected.mainSha).ok && git('verify-commit', expected.developSha).ok;
      const localChecks =
        sameTree && ancestry.ok && localSignatures
          ? run('npm', ['run', 'check:local'], { cwd: root })
          : { ok: false };
      const cleanAfter = git('status', '--porcelain=v1', '--untracked-files=all');
      const headAfter = git('rev-parse', 'HEAD');
      const treeAfter = git('rev-parse', 'HEAD^{tree}');
      if (
        !cleanAfter.ok ||
        cleanAfter.stdout !== '' ||
        !headAfter.ok ||
        headAfter.stdout !== headBefore.stdout ||
        !treeAfter.ok ||
        treeAfter.stdout !== headTree.stdout
      )
        return stop('Local worktree/index/HEAD changed during validation');
      // Reobserve remote refs after local validation; a moving candidate invalidates it.
      const finalRefs = await controls.observeRefs();
      if (
        finalRefs.kind !== 'verified' ||
        JSON.stringify(finalRefs.value) !== JSON.stringify(refs.value)
      )
        return stop('Remote refs changed during validation');
      const v = observed.value;
      const repo = v.repository;
      const ruleSetsClean = v.rulesets.every((s) => s.bypass_actors.length === 0);
      const value = {
        ...v,
        repository: {
          id: repo.node_id,
          fullName: repo.full_name,
          visibility: repo.visibility,
          defaultBranch: repo.default_branch,
          allowMergeCommit: repo.allow_merge_commit,
          allowSquashMerge: repo.allow_squash_merge,
          allowRebaseMerge: repo.allow_rebase_merge,
          allowAutoMerge: repo.allow_auto_merge,
          deleteBranchOnMerge: repo.delete_branch_on_merge,
        },
        branches: Object.fromEntries(
          ['main', 'develop'].map((name) => [name, { ...v.branches[name], ...refs.value[name] }]),
        ),
        project: project.value,
        session: closure.value,
        activation,
        temporaryBypassAbsent: ruleSetsClean,
        releaseBypassAbsent: ruleSetsClean,
        developContainsFinalMain: ancestry.ok && sameTree,
        localChecks: {
          sha: expected.developSha,
          mainSha: expected.mainSha,
          passed: localChecks.ok === true,
          command: 'npm run check:local',
        },
        routing: {
          mainPRRequired: false,
          releaseSource: 'develop',
          authority: 'glyad',
          nativeSourceRestriction: false,
          adapterActive: false,
          releaseBlocked: true,
        },
      };
      // Controls must also remain unchanged across potentially long local checks.
      const finalControls = await controls.observeControls();
      if (finalControls.kind !== 'verified' || finalControls.value.revision !== v.revision)
        return stop('Controls changed during validation; refresh observations');
      return { kind: 'verified', value, evidence: finalControls.evidence };
    },
  };
}
