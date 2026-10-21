import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { blocked, verified } from './contracts.mjs';
import { isEvidenceFor } from './validate.mjs';

/**
 * @typedef {{operationId:string,action:'upsert-ruleset',resourceId:string,arguments:object,preconditions:{revision:string}}} ProtectionOperation
 * @typedef {{operations:ProtectionOperation[],blocks:{component:string,status:'blocked'|'unsupported',reason:string,nextGate:string}[],integrationAllowed:false}} RulePlan
 */

/** Pure baseline planner. No bypass grants, API writes or automation activation. */
export function desiredProtections(capabilities, activation) {
  const plan = { operations: [], blocks: [], integrationAllowed: false };
  const stop = (component, reason, nextGate, status = 'blocked') => {
    plan.blocks.push({ component, status, reason, nextGate });
    return plan;
  };
  if (!capabilities?.repositoryId || !capabilities.revision)
    return stop(
      'identity',
      'Fresh identified rules observation required',
      'Refresh trusted capability observation',
    );
  if (capabilities.rulesets !== true)
    return stop(
      'protections',
      'Rulesets unavailable or unverified',
      'Verify supported equivalent safeguards',
      'unsupported',
    );
  if (capabilities.denyUpdates !== true)
    return stop(
      'developIntegration',
      'Deny-update enforcement unavailable or unverified',
      'Verify supported deny-update control; never allow unrestricted integration',
    );
  if (
    activation?.release === 'active' ||
    activation?.developRenewal === 'active' ||
    activation?.releaseIdentityApproved === true
  )
    return stop(
      'release',
      'Baseline restoration cannot retain active release or renewal authority',
      'Remove grants and reread effective rules',
    );
  const rule = (type) =>
    type === 'update' ? { type, parameters: { update_allows_fetch_and_merge: false } } : { type };
  const upsert = (branch, rules) => ({
    operationId: `baseline-protection-${branch}`,
    action: 'upsert-ruleset',
    resourceId: capabilities.repositoryId,
    arguments: {
      name: `governance-baseline-${branch}`,
      target: 'branch',
      enforcement: 'active',
      bypass_actors: [],
      conditions: { ref_name: { include: [`refs/heads/${branch}`], exclude: [] } },
      rules,
    },
    preconditions: { revision: capabilities.revision },
  });
  plan.operations.push(
    upsert('main', ['required_signatures', 'non_fast_forward', 'deletion'].map(rule)),
  );
  plan.operations.push(
    upsert('develop', [
      ...['required_signatures', 'non_fast_forward', 'deletion', 'update'].map(rule),
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: true,
          allowed_merge_methods: ['merge'],
        },
      },
    ]),
  );
  return stop(
    'developIntegration',
    'Real admitted hosted CI and independent reviewer gates are not activated by baseline setup',
    'Tasks 6–7 must verify actual check names, issuers and exact candidate runs before separately reviewed activation',
  );
}

const fullName = 'glyad/github-workspace-manager';
const base = `repos/${fullName}`;
function executeDefault(binary, args, options = {}) {
  try {
    return {
      ok: true,
      stdout: execFileSync(binary, args, {
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 4_000_000,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...options,
      }),
    };
  } catch (error) {
    return { ok: false, stdout: typeof error.stdout === 'string' ? error.stdout : '' };
  }
}
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Bounded setup-only REST adapter. execute receives argv and JSON stdin; stderr is
 * never returned. Caller persists intent before restoreBaselineControls(revision).
 * No retries, grants, deletes, ref updates, workflows, credentials or paid calls.
 */
export function createProtectionGitHubPort({
  repositoryId,
  actorId,
  execute = executeDefault,
  managedRulesetIds,
} = {}) {
  const evidence = (revision) => [
    {
      source: 'gh-protection-readback',
      actorId,
      resourceId: repositoryId,
      observedAt: new Date().toISOString(),
      ...(revision ? { revision } : {}),
    },
  ];
  function request(method, path, body) {
    const args = ['api', '--hostname', 'github.com', '--include', '--method', method];
    if (body !== undefined) args.push('--input', '-');
    args.push(path);
    let response;
    try {
      response = execute('gh', args, body === undefined ? {} : { input: JSON.stringify(body) });
    } catch {
      return { status: 0, value: null };
    }
    const status = Number(/^HTTP\/\S+\s+(\d{3})/m.exec(response.stdout)?.[1] ?? 0);
    try {
      const text = response.stdout
        .split(/\r?\n\r?\n/)
        .slice(1)
        .join('\n\n')
        .trim();
      return { status, value: text ? JSON.parse(text) : null };
    } catch {
      return { status, value: null };
    }
  }
  const get = (path) => request('GET', path);
  function identity() {
    if (!repositoryId || !actorId) return false;
    const actor = get('user');
    if (actor.status !== 200 || actor.value?.login !== 'glyad' || actor.value.node_id !== actorId)
      return false;
    const repo = get(base);
    return (
      repo.status === 200 &&
      repo.value?.node_id === repositoryId &&
      repo.value.full_name === fullName &&
      repo.value.visibility === 'public'
    );
  }
  async function observeControls() {
    if (!identity())
      return blocked('Authenticated maintainer/repository identity unverified', evidence());
    const repo = get(base);
    if (
      repo.status !== 200 ||
      !isObject(repo.value) ||
      repo.value.node_id !== repositoryId ||
      repo.value.full_name !== fullName ||
      repo.value.visibility !== 'public'
    )
      return blocked('Repository observation incomplete', evidence());
    const list = get(`${base}/rulesets?includes_parents=true&per_page=100`);
    if (list.status !== 200 || !Array.isArray(list.value) || list.value.length >= 100)
      return blocked('Complete ruleset inventory unavailable', evidence());
    const rulesets = [];
    for (const summary of list.value) {
      if (!isObject(summary) || !Number.isSafeInteger(summary.id) || summary.id <= 0)
        return blocked('Ruleset summary identity unavailable', evidence());
      // Organization rules cannot be changed here. Unreadable inherited detail blocks.
      const detail = get(`${base}/rulesets/${summary.id}`);
      if (
        detail.status !== 200 ||
        detail.value?.id !== summary.id ||
        !Array.isArray(detail.value.bypass_actors)
      )
        return blocked('Ruleset detail/bypass inventory unavailable', evidence());
      rulesets.push(detail.value);
    }
    const branches = {};
    for (const branch of ['main', 'develop']) {
      const effective = { status: 200, value: [] };
      let complete = false;
      for (let page = 1; page <= 20; page++) {
        const part = get(`${base}/rules/branches/${branch}?per_page=100&page=${page}`);
        if (part.status !== 200 || !Array.isArray(part.value) || part.value.length > 100)
          return blocked('Effective rule page unavailable or invalid', evidence());
        effective.value.push(...part.value);
        if (part.value.length < 100) {
          complete = true;
          break;
        }
      }
      if (!complete)
        return blocked(
          'Effective rule pagination incomplete or repeated; inventory not complete',
          evidence(),
        );
      const classic = get(`${base}/branches/${branch}/protection`);
      if (
        effective.status !== 200 ||
        !Array.isArray(effective.value) ||
        ![200, 404].includes(classic.status) ||
        (classic.status === 200 && !isObject(classic.value))
      )
        return blocked('Effective branch protection unavailable', evidence());
      branches[branch] = {
        rules: effective.value,
        classic: classic.status === 200 ? classic.value : null,
      };
    }
    const workflow = get(`${base}/actions/permissions/workflow`);
    const actions = get(`${base}/actions/permissions`);
    if (
      actions.status !== 200 ||
      !isObject(actions.value) ||
      typeof actions.value.enabled !== 'boolean' ||
      typeof actions.value.sha_pinning_required !== 'boolean' ||
      (!['all', 'local_only', 'selected'].includes(actions.value.allowed_actions) &&
        !(actions.value.enabled === false && actions.value.allowed_actions === undefined))
    )
      return blocked('Actions policy observation incomplete', evidence());
    // This endpoint applies only after selected policy is configured. Never
    // interpret an inapplicable list as an empty or verified allowlist.
    const selected =
      actions.value.allowed_actions === 'selected'
        ? get(`${base}/actions/permissions/selected-actions`)
        : { status: 200, value: null, notConfigured: true };
    const workflows = get(`${base}/actions/workflows?per_page=100`);
    const alerts = get(`${base}/vulnerability-alerts`);
    const privateReports = get(`${base}/private-vulnerability-reporting`);
    const scanning = get(`${base}/code-scanning/default-setup`);
    if (
      [workflow, actions, selected, workflows, privateReports, scanning].some(
        (r) => r.status !== 200,
      ) ||
      ![204, 404].includes(alerts.status)
    )
      return blocked('Security/Actions capability observation incomplete', evidence());
    // A successful status alone does not establish usable settings. Reject
    // malformed JSON, null/primitive bodies and invalid required fields before
    // dereferencing or normalizing; preserve HTTP statuses for write receipts.
    if (
      !isObject(workflow.value) ||
      !['read', 'write'].includes(workflow.value.default_workflow_permissions) ||
      typeof workflow.value.can_approve_pull_request_reviews !== 'boolean' ||
      (!selected.notConfigured &&
        (!isObject(selected.value) ||
          typeof selected.value.github_owned_allowed !== 'boolean' ||
          typeof selected.value.verified_allowed !== 'boolean' ||
          (selected.value.patterns_allowed !== undefined &&
            (!Array.isArray(selected.value.patterns_allowed) ||
              !selected.value.patterns_allowed.every(
                (pattern) => typeof pattern === 'string',
              ))))) ||
      !isObject(workflows.value) ||
      !Number.isSafeInteger(workflows.value.total_count) ||
      workflows.value.total_count < 0 ||
      !Array.isArray(workflows.value.workflows) ||
      !isObject(privateReports.value) ||
      typeof privateReports.value.enabled !== 'boolean' ||
      !isObject(scanning.value) ||
      !['configured', 'not-configured'].includes(scanning.value.state)
    )
      return blocked('Security/Actions response body invalid or incomplete', evidence());
    const setting = (value) => ({
      capability:
        value?.status === 'enabled' || value?.status === 'disabled' ? 'available' : 'unknown',
      status: value?.status ?? 'unknown',
    });
    const value = {
      repository: repo.value,
      branches,
      rulesets,
      rulesInventoryComplete: true,
      // Existing classic protections are preserved and block automatic restoration;
      // interpreting or deleting them is a separate reconciliation, never a fallback.
      inheritedConflicts: Object.entries(branches)
        .filter(([, v]) => v.classic !== null)
        .map(([branch]) => `${branch} classic protection requires reconciliation`),
      security: {
        vulnerabilityAlerts: {
          capability: 'available',
          status: alerts.status === 204 ? 'enabled' : 'disabled',
        },
        secretScanning: setting(repo.value.security_and_analysis?.secret_scanning),
        pushProtection: setting(repo.value.security_and_analysis?.secret_scanning_push_protection),
        privateVulnerabilityReporting: {
          capability: 'available',
          status:
            privateReports.value?.enabled === true
              ? 'enabled'
              : privateReports.value?.enabled === false
                ? 'disabled'
                : 'unknown',
        },
      },
      actions: {
        enabled: actions.value.enabled,
        defaultWorkflowPermissions: workflow.value.default_workflow_permissions,
        canApprovePullRequestReviews: workflow.value.can_approve_pull_request_reviews,
        allowedActions: actions.value.allowed_actions ?? null,
        shaPinningRequired: actions.value.sha_pinning_required,
        allowlistConfigured: selected.notConfigured !== true,
        githubOwnedAllowed: selected.value?.github_owned_allowed ?? null,
        verifiedAllowed: selected.value?.verified_allowed ?? null,
        patternsAllowed: selected.notConfigured ? null : (selected.value?.patterns_allowed ?? []),
        forkExecutionAdmitted: actions.value.enabled === false ? false : null,
        policyStatus:
          actions.value.allowed_actions === 'selected' &&
          actions.value.sha_pinning_required === true &&
          selected.value?.github_owned_allowed === false &&
          selected.value?.verified_allowed === false &&
          (selected.value.patterns_allowed ?? []).length === 0
            ? 'verified'
            : 'pending-activation',
        policyNextGate:
          'Task 7 must configure and verify selected reviewed immutable Actions and SHA pinning before any execution enablement; never temporarily enable during baseline setup',
      },
      codeScanning: {
        status: 'pending',
        configured: scanning.value?.state === 'configured',
        observedState: scanning.value?.state,
        reason:
          'Task 7 trusted admission/worker and meaningful real product scan pending; default setup push triggers are outside approved trigger scope',
      },
    };
    value.revision = digest(value);
    return verified(value, evidence(value.revision));
  }
  async function restoreBaselineControls(expectedRevision, { recordOperation } = {}) {
    const before = await observeControls();
    if (before.kind !== 'verified') return before;
    if (!expectedRevision || before.value.revision !== expectedRevision)
      return blocked(
        'Protection/settings revision advanced; refresh intent before mutation',
        before.evidence,
      );
    if (
      before.value.inheritedConflicts.length ||
      before.value.rulesets.some(
        (s) => s.bypass_actors.length || s.source_type !== 'Repository' || s.source !== fullName,
      )
    )
      return blocked(
        'Existing bypass/inherited/classic rules require explicit reconciliation; no broad replacement',
        before.evidence,
      );
    const plan = desiredProtections(
      { repositoryId, revision: expectedRevision, rulesets: true, denyUpdates: true },
      {},
    );
    const mutations = [];
    for (const op of plan.operations) {
      const matches = before.value.rulesets.filter((s) => s.name === op.arguments.name);
      if (matches.length > 1)
        return blocked('Duplicate baseline ruleset name; reconcile exact IDs', before.evidence);
      if (managedRulesetIds) {
        const branch = op.arguments.conditions.ref_name.include[0].split('/').at(-1);
        if (
          !Number.isSafeInteger(managedRulesetIds[branch]) ||
          matches.length !== 1 ||
          matches[0].id !== managedRulesetIds[branch]
        )
          return blocked(
            'Adopted ruleset identity missing or changed; creation fallback denied',
            before.evidence,
          );
      }
      mutations.push({
        method: matches.length ? 'PUT' : 'POST',
        path: `${base}/rulesets${matches.length ? `/${matches[0].id}` : ''}`,
        body: op.arguments,
      });
    }
    // GitHub's disabled repository API rejects the combined selected/pinning
    // payload and may omit allowed_actions on readback. Keep execution disabled;
    // policy/list/pinning configuration is a separate mandatory activation gate.
    // Never enable Actions temporarily to configure it during baseline setup.
    mutations.push(
      {
        method: 'PUT',
        path: `${base}/actions/permissions/workflow`,
        body: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false },
      },
      {
        method: 'PUT',
        path: `${base}/actions/permissions`,
        body: { enabled: false },
      },
      { method: 'PUT', path: `${base}/vulnerability-alerts` },
      { method: 'PUT', path: `${base}/private-vulnerability-reporting` },
      {
        method: 'PATCH',
        path: base,
        body: {
          security_and_analysis: {
            secret_scanning: { status: 'enabled' },
            secret_scanning_push_protection: { status: 'enabled' },
          },
        },
      },
    );
    const classify = (status) =>
      status >= 200 && status < 300
        ? 'acknowledged'
        : status === 401
          ? 'authentication-required'
          : status === 403
            ? 'permission-denied'
            : status === 404
              ? 'endpoint-unavailable'
              : status === 409
                ? 'conflict'
                : status === 422
                  ? 'validation-failed'
                  : status === 429
                    ? 'rate-limited'
                    : status >= 500
                      ? 'service-unavailable'
                      : 'unknown-response';
    const receipts = [];
    async function persistOperation(record) {
      if (recordOperation === undefined) return true;
      if (typeof recordOperation !== 'function') return false;
      try {
        const r = await recordOperation(structuredClone(record));
        return (
          r?.kind === 'verified' &&
          isEvidenceFor(r.evidence, actorId, [repositoryId]) &&
          JSON.stringify(r.value) === JSON.stringify(record)
        );
      } catch {
        return false;
      }
    }
    for (const [index, mutation] of mutations.entries()) {
      if (!identity())
        return blocked(
          'Identity changed during restoration; reconcile partial effects',
          evidence(),
        );
      const operation = { index, method: mutation.method, path: mutation.path };
      if (!(await persistOperation({ phase: 'intent', ...operation })))
        return blocked('Operation intent journal unavailable; remote attempt blocked', evidence());
      const response = request(mutation.method, mutation.path, mutation.body);
      const receipt = {
        ...operation,
        httpStatus: response.status,
        classification: classify(response.status),
      };
      if (!(await persistOperation({ phase: 'result', ...receipt })))
        return {
          kind: 'blocked',
          reason: 'Operation result journal unavailable; reconcile outcome before continuing',
          failedOperation: receipt,
          completedOperations: receipts,
          evidence: evidence(),
        };
      if (![200, 201, 204].includes(response.status))
        return {
          kind: 'uncertain',
          reason: 'Bounded restoration denied or outcome unknown; reread controls before retry',
          failedOperation: receipt,
          completedOperations: receipts,
          evidence: evidence(),
        };
      receipts.push(receipt);
    }
    const after = await observeControls();
    if (after.kind !== 'verified') return after;
    const v = after.value;
    const actions = v.actions;
    const rulesOkay = plan.operations.every((op) =>
      v.rulesets.some(
        (s) =>
          s.name === op.arguments.name &&
          s.enforcement === 'active' &&
          s.bypass_actors.length === 0 &&
          sameProtectionSemantics(s, op.arguments),
      ),
    );
    const settingsOkay =
      Object.values(v.security).every((s) => s.status === 'enabled') &&
      actions.enabled === false &&
      actions.defaultWorkflowPermissions === 'read' &&
      actions.canApprovePullRequestReviews === false &&
      actions.forkExecutionAdmitted === false;
    return rulesOkay && settingsOkay
      ? after
      : blocked(
          'Restoration write acknowledgements did not establish selected readback; reconcile controls',
          after.evidence,
        );
  }
  async function observeRefs() {
    if (!identity()) return blocked('Authenticated identity unverified', evidence());
    const refs = {};
    for (const name of ['main', 'develop']) {
      const branch = get(`${base}/branches/${name}`);
      const sha = branch.value?.commit?.sha;
      if (branch.status !== 200 || !/^[0-9a-f]{40}$/.test(sha ?? ''))
        return blocked('Remote ref unresolved', evidence());
      const commit = get(`${base}/commits/${sha}`);
      if (commit.status !== 200 || commit.value?.sha !== sha)
        return blocked('Exact remote commit unresolved', evidence());
      refs[name] = { sha, signatureVerified: commit.value.commit?.verification?.verified === true };
    }
    return verified(refs, evidence());
  }
  return { observeControls, restoreBaselineControls, observeRefs };
}

/** Compare only validated protection semantics; server metadata/order is not policy. */
function sameProtectionSemantics(actual, desired) {
  const sameSet = (a, b) =>
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.every((x) => typeof x === 'string') &&
    b.every((x) => typeof x === 'string') &&
    JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
  const conditions = actual.conditions;
  if (
    !conditions ||
    Object.keys(conditions).some((key) => key !== 'ref_name') ||
    !conditions.ref_name ||
    Object.keys(conditions.ref_name).some((key) => !['include', 'exclude'].includes(key)) ||
    !sameSet(conditions.ref_name.include, desired.conditions.ref_name.include) ||
    !sameSet(conditions.ref_name.exclude ?? [], desired.conditions.ref_name.exclude)
  )
    return false;
  const normalize = (rules) => {
    if (!Array.isArray(rules)) return null;
    const values = [];
    for (const rule of rules) {
      const p = rule.parameters ?? {};
      if (['required_signatures', 'non_fast_forward', 'deletion'].includes(rule.type)) {
        if (Object.keys(p).length) return null;
        values.push({ type: rule.type });
      } else if (rule.type === 'update') {
        if (
          Object.keys(p).some((k) => k !== 'update_allows_fetch_and_merge') ||
          (p.update_allows_fetch_and_merge ?? false) !== false
        )
          return null;
        values.push({ type: 'update', allowsFetchAndMerge: false });
      } else if (rule.type === 'pull_request') {
        const known = [
          'required_approving_review_count',
          'dismiss_stale_reviews_on_push',
          'require_code_owner_review',
          'require_last_push_approval',
          'required_review_thread_resolution',
          'allowed_merge_methods',
          'automatic_copilot_code_review_enabled',
          'required_reviewers',
          'require_extra_approval_for_unattributed_changes',
        ];
        // Native GitHub UI: this flag adds approval only for unattributed
        // Copilot PRs when the required count is nonzero. Never write it here.
        if (
          (p.required_reviewers !== undefined &&
            (!Array.isArray(p.required_reviewers) || p.required_reviewers.length !== 0)) ||
          (p.require_extra_approval_for_unattributed_changes !== undefined &&
            (typeof p.require_extra_approval_for_unattributed_changes !== 'boolean' ||
              p.required_approving_review_count !== 0))
        )
          return null;
        if (
          Object.keys(p).some((k) => !known.includes(k)) ||
          (p.automatic_copilot_code_review_enabled !== undefined &&
            p.automatic_copilot_code_review_enabled !== false) ||
          !sameSet(p.allowed_merge_methods ?? ['merge', 'squash', 'rebase'], ['merge'])
        )
          return null;
        values.push({
          type: 'pull_request',
          approvals: p.required_approving_review_count ?? 0,
          dismiss: p.dismiss_stale_reviews_on_push ?? false,
          owners: p.require_code_owner_review ?? false,
          lastPush: p.require_last_push_approval ?? false,
          conversations: p.required_review_thread_resolution ?? false,
        });
      } else return null;
    }
    return values.sort((a, b) => a.type.localeCompare(b.type));
  };
  const a = normalize(actual.rules),
    d = normalize(desired.rules);
  return a !== null && d !== null && JSON.stringify(a) === JSON.stringify(d);
}
