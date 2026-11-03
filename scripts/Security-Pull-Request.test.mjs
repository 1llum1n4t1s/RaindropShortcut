import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { BRANCH, candidateFiles, validatePush, pushMerge, prepare, merge, report, duplicateValidationSuite } from './Security-Pull-Request.mjs';

const root = process.env.BUN_SECURITY_TEST_ROOT;
assert.ok(root && resolve(root) === root, 'BUN_SECURITY_TEST_ROOT must name an existing absolute task directory');
const fixtures = mkdtempSync(join(root, 'github-tests-'));
// 実際の Actions run の識別子・summary を fixture の API/監査結果へ混ぜない。
const ambient = { GITHUB_RUN_ID: process.env.GITHUB_RUN_ID, GITHUB_STEP_SUMMARY: process.env.GITHUB_STEP_SUMMARY };
delete process.env.GITHUB_RUN_ID;
process.env.GITHUB_STEP_SUMMARY = join(fixtures, 'fixture-step-summary.md');
after(() => {
  for (const [name, value] of Object.entries(ambient)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
test('GitHub Actions ambient run and summary are isolated from offline fixtures', () => {
  assert.equal(process.env.GITHUB_RUN_ID, undefined);
  assert.equal(process.env.GITHUB_STEP_SUMMARY, join(fixtures, 'fixture-step-summary.md'));
});
function git(cwd, args, input) {
  const result = spawnSync('git', args, { cwd, input, encoding: 'utf8', env: { ...process.env,
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function fixture(name) {
  const directory = join(fixtures, name); mkdirSync(directory);
  const remote = join(directory, 'remote.git'); mkdirSync(remote);
  git(remote, ['init', '--bare', '--quiet']);
  const tree = git(remote, ['mktree'], '');
  const base = git(remote, ['commit-tree', tree], 'base');
  const head = git(remote, ['commit-tree', tree, '-p', base], 'head');
  const tested = git(remote, ['commit-tree', tree, '-p', base, '-p', head], 'tested');
  const other = git(remote, ['commit-tree', tree, '-p', head], 'other');
  git(remote, ['update-ref', 'refs/heads/main', base]);
  git(remote, ['update-ref', `refs/heads/${BRANCH}`, head]);
  // 仮マージ ref を保持し、ローカル bare remote の GC 対象から外す。
  git(remote, ['update-ref', 'refs/pull/1/merge', tested]);
  const working = join(directory, 'push'); mkdirSync(working);
  return { remote, directory: working, baseBranch: 'main', base, head, merge: tested, other };
}
test('candidate path allowlist rejects workflow/code and symlink-independent traversal', () => {
  assert.throws(() => candidateFiles({ changedFiles: ['../package.json'] }, fixtures), /Disallowed/);
  assert.throws(() => candidateFiles({ changedFiles: ['.github/workflows/ci.yml'] }, fixtures), /Disallowed/);
  assert.throws(() => candidateFiles({ changedFiles: ['package.json', 'package.json'] }, fixtures), /Invalid/);
  writeFileSync(join(fixtures, 'package.json'), '{}');
  assert.equal(candidateFiles({ changedFiles: ['package.json'] }, fixtures)[0].content, 'e30=');
});
test('pre-push requires exactly two advertised matching old and new OIDs', () => {
  const [base, head, tested] = ['1', '2', '3'].map(value => value.repeat(40));
  const lines = `${tested} ${tested} refs/heads/main ${base}\n${tested} ${tested} refs/heads/${BRANCH} ${head}\n`;
  assert.doesNotThrow(() => validatePush(lines, 'refs/heads/main', base, head, tested));
  for (const wrong of ['', lines.split('\n')[0], lines.replace(base, head), lines + lines, lines.replaceAll(tested, head)])
    assert.throws(() => validatePush(wrong, 'refs/heads/main', base, head, tested));
});
test('normal atomic FF push integrates exactly the tested merge and advances both refs', () => {
  const value = fixture('success');
  pushMerge(value);
  for (const branch of ['main', BRANCH]) assert.equal(git(value.remote, ['rev-parse', `refs/heads/${branch}`]), value.merge);
});
test('rejects base race even when remote base already equals PR head, an ancestor of merge', () => {
  const value = fixture('base-race');
  git(value.remote, ['update-ref', 'refs/heads/main', value.head]);
  assert.throws(() => pushMerge(value), /refusing update/);
  assert.equal(git(value.remote, ['rev-parse', 'refs/heads/main']), value.head);
  assert.equal(git(value.remote, ['rev-parse', `refs/heads/${BRANCH}`]), value.head);
});
test('rejects source race and atomically leaves base unchanged', () => {
  const value = fixture('source-race');
  git(value.remote, ['update-ref', `refs/heads/${BRANCH}`, value.base]);
  assert.throws(() => pushMerge(value), /refusing update/);
  assert.equal(git(value.remote, ['rev-parse', 'refs/heads/main']), value.base);
});
test('rejects source divergence without advancing default branch', () => {
  const value = fixture('source-diverged');
  git(value.remote, ['update-ref', `refs/heads/${BRANCH}`, value.other]);
  assert.throws(() => pushMerge(value), /refusing update/);
  assert.equal(git(value.remote, ['rev-parse', 'refs/heads/main']), value.base);
});
test('merge cannot use candidate report as CI success evidence', async () => {
  let calls = 0;
  await assert.rejects(merge({ request() { calls++; } }, { 'validation-success': 'false' }), /Trusted CI/);
  assert.equal(calls, 0);
});
test('prepare creates only allowed Git database tree and reuses identical owned PR', { timeout: 30000 }, async () => {
  const value = fixture('prepare');
  git(value.remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const candidate = join(fixtures, 'candidate'); mkdirSync(candidate);
  writeFileSync(join(candidate, 'package.json'), '{"dependencies":{"example":"2.0.0"}}');
  const reportFile = join(fixtures, 'candidate-report.json');
  writeFileSync(reportFile, JSON.stringify({ changedFiles: ['package.json'], candidateRoot: candidate, remaining: [{ package: 'unfixed' }] }));
  const tree = 'a'.repeat(40), head = 'b'.repeat(40), tested = 'c'.repeat(40);
  let created = false;
  let prExists = false, failPr = true, closedIntentional = false;
  let priorMerged = false;
  const writes = [];
  const pr = { number: 1, state: 'open', user: { id: 41898282, login: 'github-actions[bot]' },
    base: { sha: value.base, ref: 'main', repo: { full_name: 'owner/repo' } },
    head: { sha: head, ref: BRANCH, repo: { full_name: 'owner/repo' } } };
  const api = { repository: 'owner/repo', async request(path, method = 'GET', payload) {
    if (method !== 'GET') writes.push([path, payload]);
    if (path === '') return { full_name: 'owner/repo', default_branch: 'main' };
    if (path === '/git/ref/heads/main') return { object: { sha: value.base } };
    if (path === `/git/ref/heads/${BRANCH}`) return created ? { object: { sha: head } } : null;
    if (path.startsWith('/pulls?state=closed')) return [
      ...(closedIntentional ? [{ ...pr, state: 'closed' }] : []),
      ...(priorMerged ? [{ ...pr, head: { ...pr.head, sha: value.head }, merged_at: '2026-11-03', merge_commit_sha: value.merge }] : []),
    ];
    if (path.startsWith('/pulls?')) return prExists ? [pr] : [];
    if (path === `/git/commits/${value.base}`) return { tree: { sha: 'd'.repeat(40) } };
    if (path === `/git/commits/${head}`) return { tree: { sha: tree }, parents: priorMerged ? [{ sha: value.merge }, { sha: value.base }] : [{ sha: value.base }], message: 'fix(deps): Bun の脆弱な依存関係を更新' };
    if (path === `/commits/${head}`) return { author: { id: 41898282 }, committer: { id: 41898282 } };
    if (path === '/git/blobs') return { sha: 'e'.repeat(40) };
    if (path === '/git/trees') return { sha: tree };
    if (path === '/git/commits') return { sha: head };
    if (path === '/git/refs') { created = true; return {}; }
    if (path === '/pulls') { if (failPr) throw Error('transient PR POST failure'); prExists = true; return pr; }
    if (path === '/pulls/1') return pr;
    if (path === '/git/ref/pull/1/merge') return { object: { sha: tested } };
    if (path === `/git/commits/${tested}`) return { parents: [{ sha: value.base }, { sha: head }] };
    if (path.startsWith('/compare/')) return { files: [{ filename: 'package.json', status: 'modified' }] };
    throw Error(`Unexpected call ${path}`);
  } };
  const old = process.env.GITHUB_SHA; process.env.GITHUB_SHA = value.base;
  try {
    await assert.rejects(prepare(api, { report: reportFile, checkout: value.remote }), /transient PR POST failure/);
    assert.equal(created, true, 'Branch creation must precede simulated PR POST failure');
    assert.deepEqual(writes.find(([path]) => path === '/git/commits')[1].parents, [value.base]);
    writes.length = 0; failPr = false;
    const output = await prepare(api, { report: reportFile, checkout: value.remote });
    assert.equal(output.remaining_count, 1);
    assert.equal(output.merge_sha, tested);
    assert.deepEqual(writes.find(([path]) => path === '/git/trees')[1].tree.map(item => item.path), ['package.json']);
    assert.ok(!writes.some(([path]) => path === '/git/commits'), 'Exact orphan recovery must reuse the original commit');
    writes.length = 0;
    assert.deepEqual(await prepare(api, { report: reportFile, checkout: value.remote }), output);
    assert.ok(!writes.some(([path]) => ['/git/commits', '/git/refs', '/pulls'].includes(path)));
    prExists = false; priorMerged = true; failPr = true;
    value.base = value.other;
    git(value.remote, ['update-ref', 'refs/heads/main', value.base]);
    process.env.GITHUB_SHA = value.base;
    pr.base.sha = value.base;
    await assert.rejects(prepare(api, { report: reportFile, checkout: value.remote }), /transient PR POST failure/);
    failPr = false;
    assert.equal((await prepare(api, { report: reportFile, checkout: value.remote })).pr_number, 1,
      'Repeat generation orphan with owned prior merge parent must resume');
    prExists = false; closedIntentional = true;
    await assert.rejects(prepare(api, { report: reportFile, checkout: value.remote }), /closed PR/);
  } finally { if (old === undefined) delete process.env.GITHUB_SHA; else process.env.GITHUB_SHA = old; }
});
test('approved mitigated advisory creates no issue; failure reuses owned marker issue', async () => {
  const file = join(fixtures, 'report.json');
  writeFileSync(file, JSON.stringify({ status: 'mitigated', remaining: [], rawAfter: { deepmerge: [{}] } }));
  const writes = [];
  const api = { repository: 'owner/repo', async request(path, method = 'GET', payload) {
    if (path === '') return { full_name: 'owner/repo', default_branch: 'main', has_issues: true };
    if (path.startsWith('/issues?')) return [];
    writes.push([path, method, payload]); return { number: 4 };
  } };
  assert.deepEqual(await report(api, { report: file }), { issue_reporting: 'clear' });
  assert.equal(writes.length, 0);
  api.request = async (path, method = 'GET', payload) => {
    if (path === '') return { full_name: 'owner/repo', default_branch: 'main', has_issues: true };
    if (path.startsWith('/issues?')) return [{ number: 4, user: { id: 41898282 }, body: '<!-- bun-security-automation -->\nold' }];
    writes.push([path, method, payload]); return { number: 4 };
  };
  assert.deepEqual(await report(api, { status: 'validation-failed', details: 'CI failed' }), { issue_number: 4 });
  assert.equal(writes[0][0], '/issues/4');
  assert.equal(writes[0][1], 'PATCH');
  writes.length = 0;
  assert.deepEqual(await report(api, { report: file }), { issue_reporting: 'unchanged' });
  assert.equal(writes.length, 0, 'Pre-validation audit must not close a CI-failure issue');
  const summary = join(fixtures, 'summary.md');
  const oldSummary = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_STEP_SUMMARY = summary;
  try { await report(api, { report: file }); }
  finally {
    if (oldSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = oldSummary;
  }
  assert.match(readFileSync(summary, 'utf8'), /"rawAuditSucceeded": false/);
  assert.match(readFileSync(summary, 'utf8'), /"deepmerge"/);
  assert.deepEqual(await report(api, { status: 'resolved' }), { issue_reporting: 'clear' });
  assert.deepEqual(writes[0], ['/issues/4', 'PATCH', { state: 'closed' }]);
  writes.length = 0;
  writeFileSync(file, JSON.stringify({ status: 'remaining', result_changed: true, remaining: [{ package: 'unfixed', url: 'https://example.invalid/advisory' }] }));
  await report(api, { report: file });
  assert.ok(!writes.some(([, , payload]) => payload.state === 'closed'), 'Partial fix must preserve unresolved issue');
  assert.match(writes[0][2].body, /https:\/\/example.invalid\/advisory/);
  writes.length = 0;
  writeFileSync(file, JSON.stringify({ status: 'mitigated', result_changed: false, remaining: [], needs_followup: true,
    upstreamFixes: [{ package: 'deepmerge', to: '5.0.0' }] }));
  await report(api, { report: file });
  assert.match(writes[0][2].body, /5\.0\.0/);
  assert.ok(!writes.some(([, , payload]) => payload.state === 'closed'));
  process.env.GITHUB_STEP_SUMMARY = summary;
  try { await report(api, { status: 'validation-failed' }); }
  finally { if (oldSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY; else process.env.GITHUB_STEP_SUMMARY = oldSummary; }
  assert.match(readFileSync(summary, 'utf8'), /"remainingCount": null/);
  assert.match(readFileSync(summary, 'utf8'), /"mitigatedCount": null/);
});
test('protected branch is held after exact server merge validation without git push', async () => {
  const [base, head, tested] = ['1', '2', '3'].map(value => value.repeat(40));
  const api = { repository: 'owner/repo', async request(path) {
    if (path === '') return { full_name: 'owner/repo', default_branch: 'main' };
    if (path === '/pulls/1') return { number: 1, state: 'open', user: { id: 41898282, login: 'github-actions[bot]' },
      base: { sha: base, ref: 'main', repo: { full_name: 'owner/repo' } },
      head: { sha: head, ref: BRANCH, repo: { full_name: 'owner/repo' } } };
    if (path === '/git/ref/heads/main') return { object: { sha: base } };
    if (path === `/git/ref/heads/${BRANCH}`) return { object: { sha: head } };
    if (path === '/git/ref/pull/1/merge') return { object: { sha: tested } };
    if (path === `/git/commits/${tested}`) return { parents: [{ sha: base }, { sha: head }] };
    if (path.startsWith('/compare/')) return { files: [{ filename: 'bun.lock', status: 'modified' }] };
    if (path.startsWith('/branches/')) return { protected: true };
    if (path.startsWith('/rules/')) return [];
    throw Error(`Unexpected call ${path}`);
  } };
  assert.deepEqual(await merge(api, { pr: '1', 'base-sha': base, 'head-sha': head, 'merge-sha': tested,
    'validation-success': 'true' }), { merged: false, hold_reason: 'Branch protection or ruleset requires manual merge' });
  const options = { pr: '1', 'base-sha': base, 'head-sha': head, 'merge-sha': tested, 'validation-success': 'true' };
  for (const mutate of [pr => { pr.user.id = 7; }, pr => { pr.user.login = 'someone'; },
    pr => { pr.head.sha = base; }, pr => { pr.head.ref = 'other'; },
    pr => { pr.head.repo.full_name = 'attacker/fork'; }, pr => { pr.base.ref = 'other'; }]) {
    const guarded = { ...api, async request(path) { const value = await api.request(path); if (path === '/pulls/1') mutate(value); return value; } };
    await assert.rejects(merge(guarded, options), /PR/);
  }
  const invalidDiff = { ...api, async request(path) { return path.startsWith('/compare/') ? {
    files: [{ filename: '.github/workflows/ci.yml', status: 'modified' }] } : api.request(path); } };
  await assert.rejects(merge(invalidDiff, options), /non-dependency/);
  for (const status of ['pending', 'failure']) {
    const pending = { ...api, async request(path) {
      if (path.startsWith('/branches/')) return { protected: false };
      if (path.includes('/check-runs?')) return { check_runs: status === 'pending' ?
        [{ app: { slug: 'github-actions' }, status: 'in_progress', conclusion: null }] : [] };
      if (path.includes('/status?')) return { total_count: 1, statuses: [{ state: status }] };
      if (path.includes('/check-suites?')) return { check_suites: [] };
      return api.request(path);
    } };
    assert.equal((await merge(pending, options)).merged, false, 'External pending/failing check must hold merge');
  }
  const oldRun = process.env.GITHUB_RUN_ID; process.env.GITHUB_RUN_ID = '42';
  const checks = { ...api, async request(path) {
    if (path === '/actions/runs/42') return { check_suite_id: 42 };
    if (path.includes('/check-suites?')) return { check_suites: [] };
    if (path.startsWith('/branches/')) return { protected: false };
    if (path.includes('/check-runs?')) return { check_runs: [{ app: { slug: 'github-actions' },
      details_url: 'https://github.com/owner/repo/actions/runs/42/job/1', status: 'in_progress' }] };
    if (path.includes('/status?')) return { total_count: 0, statuses: [] };
    return api.request(path);
  } };
  try {
    await assert.rejects(merge(checks, options), /Temporary root required/, 'Own current-run check is represented by trusted needs result');
    const external = { ...checks, async request(path) {
      const result = await checks.request(path);
      if (result?.check_runs) result.check_runs[0].details_url = 'https://github.com/owner/repo/actions/runs/420/job/1';
      return result;
    } };
    assert.equal((await merge(external, options)).merged, false, 'Another run must not use current-run exemption');
    const suiteOnly = { ...checks, async request(path) {
      if (path.startsWith('/actions/runs?')) return { total_count: 0, workflow_runs: [] };
      if (path.includes('/check-suites?')) return { check_suites: [{ id: 7, app: { slug: 'github-actions' }, status: 'completed', conclusion: 'action_required' }] };
      if (path.includes('/check-runs?')) return { check_runs: [] };
      return checks.request(path);
    } };
    assert.match((await merge(suiteOnly, options)).hold_reason, /suite/, 'Approval-required suite with no runs must hold merge');
  } finally { if (oldRun === undefined) delete process.env.GITHUB_RUN_ID; else process.env.GITHUB_RUN_ID = oldRun; }
});
test('no force or REST merge endpoint is present', () => {
  const source = readFileSync(new URL('./Security-Pull-Request.mjs', import.meta.url), 'utf8');
  assert.ok(!source.includes('--force'));
  assert.ok(!source.includes("'PUT'"));
});
test('only exact unambiguous approval-required duplicate validation suite can be represented by trusted CI', async () => {
  const head = '1'.repeat(40);
  const suite = { id: 100, app: { slug: 'github-actions' }, conclusion: 'action_required' };
  const run = { id: 10, check_suite_id: 100, workflow_id: 20, event: 'pull_request', head_branch: BRANCH,
    head_sha: head, repository: { full_name: 'owner/repo' }, head_repository: { full_name: 'owner/repo' },
    path: '.github/workflows/dependency-validation.yml', status: 'completed', conclusion: 'action_required' };
  const api = { repository: 'owner/repo', async request(path) {
    if (path.startsWith('/actions/runs?')) return { total_count: 1, workflow_runs: [structuredClone(run)] };
    if (path === '/actions/workflows/dependency-validation.yml') return { id: 20, path: run.path };
    throw Error(`Unexpected call ${path}`);
  } };
  assert.equal((await duplicateValidationSuite(api, suite, head)).duplicate, true);
  for (const mutate of [value => { value.path = '.github/workflows/mobile-ios.yml'; },
    value => { value.workflow_id = 21; }, value => { value.head_sha = '2'.repeat(40); },
    value => { value.head_repository.full_name = 'attacker/fork'; }, value => { value.event = 'push'; }]) {
    const mismatch = { ...api, async request(path) {
      const result = await api.request(path); if (result.workflow_runs) mutate(result.workflow_runs[0]); return result;
    } };
    assert.equal((await duplicateValidationSuite(mismatch, suite, head)).duplicate, false);
  }
  for (const count of [0, 2]) {
    const ambiguous = { ...api, async request() { return { total_count: count, workflow_runs: Array.from({ length: count }, () => run) }; } };
    assert.equal((await duplicateValidationSuite(ambiguous, suite, head)).duplicate, false);
  }
});
