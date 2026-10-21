import test from 'node:test';
import assert from 'node:assert/strict';
import { desiredProtections } from '../../tools/governance/protections.mjs';
import { verifyBaseline } from '../../tools/governance/verify-baseline.mjs';

const expected = {
  repositoryId: 'R_repo',
  actorId: 'U_owner',
  mainSha: 'a'.repeat(40),
  developSha: 'b'.repeat(40),
  projectId: 'PVT_project',
  setupOperationId: 'setup-4',
};
const evidence = () => [
  {
    source: 'trusted-test-observation',
    actorId: 'U_owner',
    resourceId: 'R_repo',
    observedAt: new Date().toISOString(),
    revision: 'snapshot-1',
  },
];
function observation() {
  return {
    repository: {
      id: 'R_repo',
      fullName: 'glyad/github-workspace-manager',
      visibility: 'public',
      defaultBranch: 'main',
      allowMergeCommit: true,
      allowSquashMerge: false,
      allowRebaseMerge: false,
      allowAutoMerge: false,
      deleteBranchOnMerge: false,
    },
    project: { id: 'PVT_project', public: true, verified: true },
    branches: {
      main: {
        sha: expected.mainSha,
        signatureVerified: true,
        rules: [
          { type: 'required_signatures' },
          { type: 'non_fast_forward' },
          { type: 'deletion' },
        ],
      },
      develop: {
        sha: expected.developSha,
        signatureVerified: true,
        rules: [
          { type: 'required_signatures' },
          { type: 'non_fast_forward' },
          { type: 'deletion' },
          { type: 'update' },
          {
            type: 'pull_request',
            parameters: {
              required_approving_review_count: 0,
              required_review_thread_resolution: true,
            },
          },
        ],
      },
    },
    rulesets: [{ id: 1, enforcement: 'active', bypass_actors: [] }],
    rulesInventoryComplete: true,
    inheritedConflicts: [],
    temporaryBypassAbsent: true,
    releaseBypassAbsent: true,
    developContainsFinalMain: true,
    localChecks: {
      sha: expected.developSha,
      mainSha: expected.mainSha,
      passed: true,
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
    security: Object.fromEntries(
      [
        'vulnerabilityAlerts',
        'secretScanning',
        'pushProtection',
        'privateVulnerabilityReporting',
      ].map((name) => [name, { status: 'enabled', capability: 'available' }]),
    ),
    codeScanning: {
      status: 'pending',
      configured: false,
      reason: 'Meaningful product code and trusted workflow pending',
    },
    actions: {
      defaultWorkflowPermissions: 'read',
      canApprovePullRequestReviews: false,
      allowedActions: 'selected',
      githubOwnedAllowed: false,
      verifiedAllowed: false,
      patternsAllowed: [],
      enabled: false,
      shaPinningRequired: true,
      forkExecutionAdmitted: false,
    },
    activation: {
      hostedCI: 'inactive',
      hostedReviewer: 'inactive',
      release: 'inactive',
      developRenewal: 'inactive',
      ordinaryIntegration: 'blocked',
      paidReviewApproved: false,
      releaseIdentityApproved: false,
    },
    session: {
      operationId: 'setup-4',
      state: 'closed',
      closureRecordVerified: true,
      remoteClosureRecordVerified: true,
    },
  };
}
const portFor = (value) => ({
  observeBaseline: async () => ({ kind: 'verified', value, evidence: evidence() }),
});
const capabilities = {
  repositoryId: 'R_repo',
  rulesets: true,
  denyUpdates: true,
  revision: 'before-1',
};

test('planner denies develop integration while real checks and reviewer are unavailable', () => {
  const plan = desiredProtections(capabilities, {
    hostedCI: 'inactive',
    hostedReviewer: 'inactive',
  });
  assert.equal(plan.integrationAllowed, false);
  const develop = plan.operations.find((op) =>
    op.arguments.conditions.ref_name.include.includes('refs/heads/develop'),
  );
  assert.ok(develop.arguments.rules.some((rule) => rule.type === 'update'));
  assert.ok(!develop.arguments.rules.some((rule) => rule.type === 'required_status_checks'));
  assert.deepEqual(develop.arguments.bypass_actors, []);
});
test('planner preserves direct main route and requires signed nonforce nondelete main', () => {
  const plan = desiredProtections(capabilities, {});
  const main = plan.operations.find((op) =>
    op.arguments.conditions.ref_name.include.includes('refs/heads/main'),
  );
  assert.deepEqual(main.arguments.rules.map((rule) => rule.type).sort(), [
    'deletion',
    'non_fast_forward',
    'required_signatures',
  ]);
  assert.equal(main.preconditions.revision, 'before-1');
});
test('unsupported deny-update has no unrestricted integration fallback', () => {
  const plan = desiredProtections({ ...capabilities, denyUpdates: false }, {});
  assert.equal(plan.integrationAllowed, false);
  assert.ok(plan.blocks.some((entry) => entry.component === 'developIntegration'));
  assert.equal(plan.operations.length, 0);
});
test('planner refuses active release grants during baseline restoration', () => {
  const plan = desiredProtections(capabilities, { release: 'active' });
  assert.equal(plan.operations.length, 0);
  assert.ok(plan.blocks.length > 0);
});
test('verified baseline permits Draft work but keeps integration and release blocked', async () => {
  const result = await verifyBaseline(portFor(observation()), expected);
  assert.equal(result.kind, 'verified');
  assert.equal(result.value.baselineComplete, true);
  assert.equal(result.value.ordinaryDraftWorkAllowed, true);
  assert.equal(result.value.ordinaryIntegrationAllowed, false);
  assert.equal(result.value.components.codeScanning.status, 'blocked');
});
const badCases = [
  [
    'temporary bypass leakage',
    (v) => {
      v.temporaryBypassAbsent = false;
    },
  ],
  [
    'actor bypass leakage',
    (v) => {
      v.rulesets[0].bypass_actors = [
        { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' },
      ];
    },
  ],
  [
    'missing main signature rule',
    (v) => {
      v.branches.main.rules.shift();
    },
  ],
  [
    'unverified check name',
    (v) => {
      v.branches.develop.rules.push({
        type: 'required_status_checks',
        parameters: { required_status_checks: [{ context: 'imaginary', integration_id: 1 }] },
      });
    },
  ],
  [
    'inherited conflicting rule',
    (v) => {
      v.inheritedConflicts = ['Main inherited pull request requirement'];
    },
  ],
  [
    'restoration denial',
    (v) => {
      v.branches.develop.rules = v.branches.develop.rules.filter((rule) => rule.type !== 'update');
    },
  ],
  [
    'main PR requirement',
    (v) => {
      v.branches.main.rules.push({ type: 'pull_request' });
    },
  ],
  [
    'linear history requirement',
    (v) => {
      v.branches.main.rules.push({ type: 'required_linear_history' });
    },
  ],
  [
    'second human approval requirement',
    (v) => {
      v.branches.develop.rules.find(
        (rule) => rule.type === 'pull_request',
      ).parameters.required_approving_review_count = 1;
    },
  ],
  [
    'incomplete rules inventory',
    (v) => {
      v.rulesInventoryComplete = false;
    },
  ],
  [
    'early develop snapshot',
    (v) => {
      v.developContainsFinalMain = false;
    },
  ],
  [
    'unsigned final baseline',
    (v) => {
      v.branches.main.signatureVerified = false;
    },
  ],
  [
    'stale checks',
    (v) => {
      v.localChecks.sha = 'c'.repeat(40);
    },
  ],
  [
    'wrong Project',
    (v) => {
      v.project.id = 'PVT_wrong';
    },
  ],
  [
    'unclosed setup session',
    (v) => {
      v.session.state = 'open';
    },
  ],
  [
    'unverified remote closure',
    (v) => {
      v.session.remoteClosureRecordVerified = false;
    },
  ],
  [
    'unrestricted Actions',
    (v) => {
      v.actions.githubOwnedAllowed = true;
    },
  ],
  [
    'future release bypass activation',
    (v) => {
      v.activation.release = 'active';
    },
  ],
  [
    'unverified security capability',
    (v) => {
      v.security.secretScanning = { status: 'unknown' };
    },
  ],
];
for (const [name, change] of badCases)
  test(`blocks normal SDLC for ${name}`, async () => {
    const value = observation();
    change(value);
    const result = await verifyBaseline(portFor(value), expected);
    assert.equal(result.kind, 'blocked');
    assert.equal(result.value.ordinaryDraftWorkAllowed, false);
    assert.equal(result.value.ordinaryIntegrationAllowed, false);
  });
test('wrong or stale evidence blocks before trusting normalized settings', async () => {
  const port = portFor(observation());
  port.observeBaseline = async () => ({
    kind: 'verified',
    value: observation(),
    evidence: [{ ...evidence()[0], actorId: 'U_wrong' }],
  });
  assert.equal((await verifyBaseline(port, expected)).kind, 'blocked');
});
test('lost restoration read remains uncertain and does not mutate', async () => {
  const result = await verifyBaseline(
    {
      observeBaseline: async () => {
        throw new Error('timeout');
      },
    },
    expected,
  );
  assert.equal(result.kind, 'uncertain');
});
test('restoration phase admits closure only after all safeguards except closure records pass', async () => {
  const value = observation();
  value.session.state = 'open';
  value.session.closureRecordVerified = false;
  value.session.remoteClosureRecordVerified = false;
  const result = await verifyBaseline(portFor(value), { ...expected, phase: 'restoration' });
  assert.equal(result.kind, 'verified');
  assert.equal(result.value.restorationVerified, true);
  assert.equal(result.value.baselineComplete, false);
  assert.equal(result.value.ordinaryDraftWorkAllowed, false);
});
test('documented unavailable security is unsupported rather than invented enabled', async () => {
  const value = observation();
  value.security.privateVulnerabilityReporting = {
    status: 'unsupported',
    capability: 'unsupported',
    reason: 'Observed account capability unavailable',
  };
  const result = await verifyBaseline(portFor(value), expected);
  assert.equal(result.kind, 'verified');
  assert.equal(result.value.components.privateVulnerabilityReporting.status, 'unsupported');
});

// Boundary fake models REST state, not normalization or verification conclusions.
const { createBaselineGitHubPort } = await import('../../tools/governance/verify-baseline.mjs');
const { createProtectionGitHubPort } = await import('../../tools/governance/protections.mjs');
function githubFixture() {
  const state = {
    mutations: [],
    rulesets: [],
    effective: { main: [], develop: [] },
    localTree: 'tree1',
  };
  const rawRepo = {
    node_id: 'R_repo',
    full_name: 'glyad/github-workspace-manager',
    visibility: 'public',
    default_branch: 'main',
    allow_merge_commit: true,
    allow_squash_merge: false,
    allow_rebase_merge: false,
    allow_auto_merge: false,
    delete_branch_on_merge: false,
    security_and_analysis: {
      secret_scanning: { status: 'disabled' },
      secret_scanning_push_protection: { status: 'disabled' },
    },
  };
  const execute = (_binary, argv, options = {}) => {
    if (_binary === 'git' && argv.includes('status'))
      return { ok: true, stdout: state.dirty || '' };
    if (_binary === 'git' && argv.includes('HEAD'))
      return { ok: true, stdout: state.head || expected.mainSha };
    if (_binary === 'git')
      return { ok: true, stdout: argv.includes('HEAD^{tree}') ? state.localTree : 'tree1' };
    if (_binary === 'npm') {
      if (state.dirtyAfter) state.dirty = state.dirtyAfter;
      if (state.headAfter) state.head = state.headAfter;
      return { ok: state.localChecksPassed !== false, stdout: 'checks' };
    }
    (state.requests ??= []).push(argv.at(-1));
    const method = argv[argv.indexOf('--method') + 1];
    const path = argv.at(-1);
    let value,
      status = 200;
    if (method !== 'GET') {
      const body = options.input ? JSON.parse(options.input) : undefined;
      state.mutations.push({ method, path, body });
      if (path.endsWith('/rulesets') && method === 'POST') {
        const row = {
          ...body,
          id: state.rulesets.length + 1,
          source_type: 'Repository',
          source: 'glyad/github-workspace-manager',
        };
        state.rulesets.push(row);
        state.effective[row.conditions.ref_name.include[0].split('/').at(-1)] = row.rules;
        value = row;
      } else {
        if (state.applyWrites) {
          if (path.endsWith('/actions/permissions')) {
            state.actionsEnabled = body.enabled;
            state.allowedActions = body.allowed_actions;
          }
          if (path.endsWith('/vulnerability-alerts')) state.alertsEnabled = true;
          if (path.endsWith('/private-vulnerability-reporting')) state.reportsEnabled = true;
          if (body?.security_and_analysis)
            rawRepo.security_and_analysis = body.security_and_analysis;
        }
        value = {};
      }
    } else if (path === 'user')
      value = { login: state.wrongActor ? 'other' : 'glyad', node_id: 'U_owner' };
    else if (path === 'repos/glyad/github-workspace-manager') value = rawRepo;
    else if (path.includes('/rulesets?')) value = state.rulesets;
    else if (/\/rulesets\/\d+$/.test(path))
      value = state.rulesets.find((row) => row.id === Number(path.split('/').at(-1)));
    else if (path === 'repos/glyad/github-workspace-manager/branches/main')
      value = { commit: { sha: expected.mainSha } };
    else if (path === 'repos/glyad/github-workspace-manager/branches/develop')
      value = { commit: { sha: expected.developSha } };
    else if (path.includes('/commits/'))
      value = { sha: path.split('/').at(-1), commit: { verification: { verified: true } } };
    else if (path.includes('/rules/branches/')) {
      const [route, query = ''] = path.split('?');
      const params = new URLSearchParams(query);
      const size = Number(params.get('per_page') || 30),
        page = Number(params.get('page') || 1);
      value = state.effective[route.split('/').at(-1)].slice((page - 1) * size, page * size);
    } else if (path.endsWith('/protection')) {
      status = 404;
      value = {};
    } else if (path.endsWith('/vulnerability-alerts')) {
      status = state.alertsEnabled ? 204 : 404;
      value = {};
    } else if (path.endsWith('/code-scanning/default-setup')) value = { state: 'not-configured' };
    else if (path.endsWith('/private-vulnerability-reporting'))
      value = { enabled: state.reportsEnabled === true };
    else if (path.endsWith('/actions/permissions/workflow'))
      value = { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false };
    else if (path.endsWith('/actions/permissions/selected-actions')) {
      status = state.selectedStatus ?? (state.allowedActions === 'all' ? 409 : 200);
      value = { github_owned_allowed: false, verified_allowed: false, patterns_allowed: [] };
    } else if (path.endsWith('/actions/permissions'))
      value = {
        enabled: state.actionsEnabled !== false,
        allowed_actions: state.allowedActions ?? 'selected',
        sha_pinning_required: true,
      };
    else if (path.endsWith('/actions/workflows?per_page=100'))
      value = { total_count: state.workflows?.length ?? 0, workflows: state.workflows ?? [] };
    else throw new Error(`Unexpected fixture request ${method} ${path}`);
    if (method === 'GET' && state.reorder && value?.conditions)
      value = {
        ...value,
        conditions: { ref_name: { exclude: [], include: value.conditions.ref_name.include } },
        rules: [...value.rules]
          .reverse()
          .map((r) =>
            r.type === 'update'
              ? { ...r, parameters: { update_allows_fetch_and_merge: false } }
              : r,
          ),
      };
    if (state.weaken && value?.rules)
      value = {
        ...value,
        rules: value.rules.map((r) =>
          r.type === 'update' ? { ...r, parameters: { update_allows_fetch_and_merge: true } } : r,
        ),
      };
    return { ok: status < 400, stdout: `HTTP/2.0 ${status} OK\r\n\r\n${JSON.stringify(value)}` };
  };
  return { state, execute };
}
test('real adapter reads disabled security distinctly from unknown capability and performs no writes', async () => {
  const f = githubFixture();
  const port = createProtectionGitHubPort({
    actorId: 'U_owner',
    repositoryId: 'R_repo',
    execute: f.execute,
  });
  const r = await port.observeControls();
  assert.equal(r.kind, 'verified');
  assert.equal(r.value.security.vulnerabilityAlerts.status, 'disabled');
  assert.equal(r.value.actions.allowedActions, 'selected');
  assert.equal(f.state.mutations.length, 0);
});
test('real adapter refuses stale revision before any protection mutation', async () => {
  const f = githubFixture();
  const port = createProtectionGitHubPort({
    actorId: 'U_owner',
    repositoryId: 'R_repo',
    execute: f.execute,
  });
  const r = await port.restoreBaselineControls('stale');
  assert.equal(r.kind, 'blocked');
  assert.equal(f.state.mutations.length, 0);
});
test('real adapter refuses wrong authenticated actor before any mutation', async () => {
  const f = githubFixture();
  f.state.wrongActor = true;
  const port = createProtectionGitHubPort({
    actorId: 'U_owner',
    repositoryId: 'R_repo',
    execute: f.execute,
  });
  assert.equal((await port.restoreBaselineControls('before')).kind, 'blocked');
  assert.equal(f.state.mutations.length, 0);
});
test('real adapter emits bounded rules/security/Actions mutations and reconciles final readback', async () => {
  const f = githubFixture();
  const port = createProtectionGitHubPort({
    actorId: 'U_owner',
    repositoryId: 'R_repo',
    execute: f.execute,
  });
  const before = await port.observeControls();
  const r = await port.restoreBaselineControls(before.value?.revision);
  // Fixture intentionally does not apply security mutations: an acknowledgement cannot prove restoration.
  assert.equal(r.kind, 'blocked');
  const rules = f.state.mutations.filter((row) => row.path.endsWith('/rulesets'));
  assert.equal(rules.length, 2);
  assert.ok(rules.every((row) => row.body.bypass_actors.length === 0));
  assert.ok(f.state.mutations.some((row) => row.body?.default_workflow_permissions === 'read'));
  assert.ok(f.state.mutations.some((row) => row.body?.allowed_actions === 'selected'));
});

function baselineCallbacks() {
  return {
    observeProjectBaseline: async () => ({
      kind: 'verified',
      value: { id: 'PVT_project', public: true, verified: true },
      evidence: [{ ...evidence()[0], resourceId: 'PVT_project' }],
    }),
    observeClosure: async () => ({
      kind: 'verified',
      value: {
        operationId: 'setup-4',
        state: 'closed',
        closureRecordVerified: true,
        remoteClosureRecordVerified: true,
      },
      evidence: ['setup-4', 'I_ledger'].map((resourceId) => ({ ...evidence()[0], resourceId })),
    }),
  };
}
test('production baseline observer binds actual refs, signatures, local checks and callbacks', async () => {
  const f = githubFixture();
  const port = await createBaselineGitHubPort({
    expected: { ...expected, closureIssueId: 'I_ledger' },
    execute: f.execute,
    ...baselineCallbacks(),
  });
  const result = await port.observeBaseline('R_repo');
  assert.equal(result.kind, 'verified');
  assert.equal(result.value.branches.main.sha, expected.mainSha);
  assert.equal(result.value.branches.develop.signatureVerified, true);
  assert.equal(result.value.localChecks.passed, true);
  assert.equal(result.value.project.id, 'PVT_project');
  assert.equal(result.value.session.operationId, 'setup-4');
  assert.equal(f.state.mutations.length, 0);
});
for (const [name, configure] of [
  [
    'different local tree',
    (f) => {
      f.state.localTree = 'wrong';
    },
  ],
  [
    'failing local check',
    (f) => {
      f.state.localChecksPassed = false;
    },
  ],
])
  test(`production observer refuses validation success for ${name}`, async () => {
    const f = githubFixture();
    configure(f);
    const port = await createBaselineGitHubPort({
      expected: { ...expected, closureIssueId: 'I_ledger' },
      execute: f.execute,
      ...baselineCallbacks(),
    });
    const result = await port.observeBaseline('R_repo');
    assert.equal(result.kind, 'verified');
    assert.equal(result.value.localChecks.passed, false);
  });
test('production observer rejects closure evidence without exact remote ledger binding', async () => {
  const f = githubFixture();
  const callbacks = baselineCallbacks();
  callbacks.observeClosure = async () => ({
    kind: 'verified',
    value: { operationId: 'setup-4' },
    evidence: [{ ...evidence()[0], resourceId: 'setup-4' }],
  });
  const port = await createBaselineGitHubPort({
    expected: { ...expected, closureIssueId: 'I_ledger' },
    execute: f.execute,
    ...callbacks,
  });
  assert.equal((await port.observeBaseline('R_repo')).kind, 'blocked');
});

for (const [name, configure] of [
  [
    'staged validation repair',
    (f) => {
      f.state.dirty = 'M  package.json\n';
    },
  ],
  [
    'untracked validation input',
    (f) => {
      f.state.dirty = '?? tests/governance/extra.test.mjs\n';
    },
  ],
  [
    'dirty candidate repaired only in worktree',
    (f) => {
      f.state.dirty = ' M package.json\n';
    },
  ],
  [
    'worktree changed during checks',
    (f) => {
      f.state.dirtyAfter = ' M tests/governance/protections.test.mjs\n';
    },
  ],
  [
    'HEAD changed during checks',
    (f) => {
      f.state.headAfter = 'c'.repeat(40);
    },
  ],
])
  test(`production observer blocks ${name}`, async () => {
    const f = githubFixture();
    configure(f);
    const port = await createBaselineGitHubPort({
      expected: { ...expected, closureIssueId: 'I_ledger' },
      execute: f.execute,
      ...baselineCallbacks(),
    });
    assert.equal((await port.observeBaseline('R_repo')).kind, 'blocked');
  });
test('complete effective rules include hidden later-page main conflict', async () => {
  const f = githubFixture();
  f.state.effective.main = [
    ...Array.from({ length: 100 }, () => ({ type: 'required_signatures' })),
    { type: 'pull_request' },
  ];
  const port = createProtectionGitHubPort({
    actorId: 'U_owner',
    repositoryId: 'R_repo',
    execute: f.execute,
  });
  const result = await port.observeControls();
  assert.equal(result.kind, 'verified');
  assert.equal(result.value.branches.main.rules.length, 101);
  const value = observation();
  value.branches.main.rules = result.value.branches.main.rules;
  assert.equal((await verifyBaseline(portFor(value), expected)).kind, 'blocked');
});
test('equivalent reordered REST conditions/rules and explicit false update default restore successfully', async () => {
  const f = githubFixture();
  f.state.applyWrites = true;
  f.state.reorder = true;
  const port = createProtectionGitHubPort({
    actorId: 'U_owner',
    repositoryId: 'R_repo',
    execute: f.execute,
  });
  const before = await port.observeControls();
  const result = await port.restoreBaselineControls(before.value.revision);
  assert.equal(result.kind, 'verified');
});
test('enabled Actions cannot infer fork gate from empty workflows or external action allowlist', async () => {
  const f = githubFixture();
  const port = createProtectionGitHubPort({
    actorId: 'U_owner',
    repositoryId: 'R_repo',
    execute: f.execute,
  });
  const observed = await port.observeControls();
  assert.equal(observed.value.actions.enabled, true);
  assert.notEqual(observed.value.actions.forkExecutionAdmitted, false);
  const value = observation();
  value.actions = observed.value.actions;
  assert.equal((await verifyBaseline(portFor(value), expected)).kind, 'blocked');
});
test('restore disables execution even for raw run and local action workflows', async () => {
  const f = githubFixture();
  f.state.applyWrites = true;
  f.state.workflows = [
    { id: 1, path: '.github/workflows/raw-run.yml', state: 'active' },
    { id: 2, path: '.github/workflows/local-action.yml', state: 'active' },
  ];
  const port = createProtectionGitHubPort({
    actorId: 'U_owner',
    repositoryId: 'R_repo',
    execute: f.execute,
  });
  const before = await port.observeControls();
  const after = await port.restoreBaselineControls(before.value.revision);
  assert.equal(after.kind, 'verified');
  assert.equal(after.value.actions.enabled, false);
  assert.equal(after.value.actions.forkExecutionAdmitted, false);
  assert.ok(
    f.state.mutations.some(
      (row) => row.path.endsWith('/actions/permissions') && row.body.enabled === false,
    ),
  );
});
test('semantic normalization still blocks a true update bypass', async () => {
  const f = githubFixture();
  f.state.applyWrites = true;
  f.state.weaken = true;
  const port = createProtectionGitHubPort({
    actorId: 'U_owner',
    repositoryId: 'R_repo',
    execute: f.execute,
  });
  const before = await port.observeControls();
  assert.equal((await port.restoreBaselineControls(before.value.revision)).kind, 'blocked');
});

test('prechange all-actions policy yields accurate restoration snapshot without querying inapplicable selected list', async () => {
  const f = githubFixture();
  f.state.allowedActions = 'all';
  const port = createProtectionGitHubPort({
    actorId: 'U_owner',
    repositoryId: 'R_repo',
    execute: f.execute,
  });
  const result = await port.observeControls();
  assert.equal(result.kind, 'verified');
  assert.equal(result.value.actions.allowedActions, 'all');
  assert.equal(result.value.actions.allowlistConfigured, false);
  assert.equal(result.value.actions.patternsAllowed, null);
  assert.equal(result.value.actions.githubOwnedAllowed, null);
  assert.ok(!f.state.requests.some((path) => path.endsWith('/selected-actions')));
});
test('selected-actions 409 remains a blocked observation when selected policy is configured', async () => {
  const f = githubFixture();
  f.state.allowedActions = 'selected';
  f.state.selectedStatus = 409;
  const port = createProtectionGitHubPort({
    actorId: 'U_owner',
    repositoryId: 'R_repo',
    execute: f.execute,
  });
  assert.equal((await port.observeControls()).kind, 'blocked');
});
test('restore from all-actions policy still requires configured selected allowlist readback', async () => {
  const f = githubFixture();
  f.state.allowedActions = 'all';
  f.state.applyWrites = true;
  const port = createProtectionGitHubPort({
    actorId: 'U_owner',
    repositoryId: 'R_repo',
    execute: f.execute,
  });
  const before = await port.observeControls();
  assert.equal(before.kind, 'verified');
  const after = await port.restoreBaselineControls(before.value.revision);
  assert.equal(after.kind, 'verified');
  assert.equal(after.value.actions.allowedActions, 'selected');
  assert.equal(after.value.actions.allowlistConfigured, true);
  assert.deepEqual(after.value.actions.patternsAllowed, []);
  assert.ok(f.state.requests.some((path) => path.endsWith('/selected-actions')));
});
