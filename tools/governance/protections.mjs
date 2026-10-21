import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { blocked, verified } from './contracts.mjs';

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

/**
 * Bounded setup-only REST adapter. execute receives argv and JSON stdin; stderr is
 * never returned. Caller persists intent before restoreBaselineControls(revision).
 * No retries, grants, deletes, ref updates, workflows, credentials or paid calls.
 */
export function createProtectionGitHubPort({
  repositoryId,
  actorId,
  execute = executeDefault,
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
      return { status: 0, value: null };
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
    const list = get(`${base}/rulesets?includes_parents=true&per_page=100`);
    if (list.status !== 200 || !Array.isArray(list.value) || list.value.length >= 100)
      return blocked('Complete ruleset inventory unavailable', evidence());
    const rulesets = [];
    for (const summary of list.value) {
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
        ![200, 404].includes(classic.status)
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
      !['all', 'local_only', 'selected'].includes(actions.value?.allowed_actions)
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
        allowedActions: actions.value.allowed_actions,
        shaPinningRequired: actions.value.sha_pinning_required,
        allowlistConfigured: selected.notConfigured !== true,
        githubOwnedAllowed: selected.value?.github_owned_allowed ?? null,
        verifiedAllowed: selected.value?.verified_allowed ?? null,
        patternsAllowed: selected.notConfigured ? null : (selected.value?.patterns_allowed ?? []),
        forkExecutionAdmitted: actions.value.enabled === false ? false : null,
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
  async function restoreBaselineControls(expectedRevision) {
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
      mutations.push({
        method: matches.length ? 'PUT' : 'POST',
        path: `${base}/rulesets${matches.length ? `/${matches[0].id}` : ''}`,
        body: op.arguments,
      });
    }
    // No required third-party Actions are needed before worker activation. Empty
    // selected allowlist is narrower than an unverified or wildcard allowlist.
    mutations.push(
      {
        method: 'PUT',
        path: `${base}/actions/permissions/workflow`,
        body: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false },
      },
      {
        method: 'PUT',
        path: `${base}/actions/permissions`,
        body: { enabled: false, allowed_actions: 'selected', sha_pinning_required: true },
      },
      {
        method: 'PUT',
        path: `${base}/actions/permissions/selected-actions`,
        body: { github_owned_allowed: false, verified_allowed: false, patterns_allowed: [] },
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
    for (const mutation of mutations) {
      if (!identity())
        return blocked(
          'Identity changed during restoration; reconcile partial effects',
          evidence(),
        );
      const response = request(mutation.method, mutation.path, mutation.body);
      if (![200, 201, 204].includes(response.status))
        return {
          kind: 'uncertain',
          reason: 'Bounded restoration denied or outcome unknown; reread controls before retry',
          evidence: evidence(),
        };
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
      actions.allowedActions === 'selected' &&
      actions.shaPinningRequired === true &&
      actions.githubOwnedAllowed === false &&
      actions.verifiedAllowed === false &&
      actions.patternsAllowed.length === 0 &&
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
        ];
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
