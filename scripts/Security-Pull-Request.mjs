// 権限のあるジョブ専用。依存パッケージや候補内のコードを実行しない。
import { appendFileSync, readFileSync, lstatSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const BRANCH = 'automation/bun-security';
const BOT = 41898282;
const marker = '<!-- bun-security-automation -->';
const commitMessage = 'fix(deps): Bun の脆弱な依存関係を更新';
const allowed = new Set(['package.json', 'bun.lock']);
function assert(ok, message) { if (!ok) throw new Error(message); }
function sha(value) { assert(/^[0-9a-f]{40}$/.test(value ?? ''), 'Invalid commit SHA'); return value; }
function output(values) {
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${String(value).replace(/[\r\n]/g, '')}\n`;
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
    else process.stdout.write(line);
  }
}
export function client(repository = process.env.GITHUB_REPOSITORY, token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
  assert(/^[\w.-]+\/[\w.-]+$/.test(repository ?? ''), 'Invalid repository');
  assert(token, 'GitHub token required');
  return { repository, token, async request(path, method = 'GET', body, optional = false) {
    const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error',
    });
    if (optional && response.status === 404) return null;
    assert(response.ok, `GitHub ${method} ${path.split('?')[0]} failed (${response.status})`);
    return response.status === 204 ? null : response.json();
  } };
}
function owned(pr, api, base) {
  assert(pr.user?.id === BOT && pr.user?.login === 'github-actions[bot]', 'PR is not owned by GitHub Actions');
  assert(pr.head?.repo?.full_name === api.repository && pr.base?.repo?.full_name === api.repository,
    'PR repository mismatch');
  assert(pr.head.ref === BRANCH && pr.base.ref === base, 'PR branch mismatch');
}
async function metadata(api) {
  const repo = await api.request('');
  assert(repo.full_name === api.repository && repo.default_branch && repo.default_branch !== BRANCH, 'Invalid default branch');
  return repo;
}
async function ref(api, name, optional = false) {
  return (await api.request(`/git/ref/${name}`, 'GET', undefined, optional))?.object?.sha;
}
export function candidateFiles(report, candidateRoot) {
  assert(Array.isArray(report.changedFiles), 'Missing changedFiles');
  assert(report.changedFiles.length <= 2 && new Set(report.changedFiles).size === report.changedFiles.length, 'Invalid changedFiles');
  return report.changedFiles.map(path => {
    assert(allowed.has(path), `Disallowed candidate path: ${path}`);
    const root = resolve(candidateRoot);
    assert(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), 'Invalid candidate root');
    const file = join(root, path);
    assert(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), 'Candidate must be a regular file');
    return { path, content: readFileSync(file).toString('base64') };
  });
}
async function allowedDiff(api, base, head) {
  const diff = await api.request(`/compare/${sha(base)}...${sha(head)}`);
  assert(Array.isArray(diff.files) && diff.files.length <= 2 && diff.files.every(file =>
    allowed.has(file.filename) && !file.previous_filename && file.status !== 'removed'), 'Branch contains non-dependency changes');
}
export async function prepare(api, options) {
  const report = JSON.parse(readFileSync(options.report, 'utf8'));
  const remaining_count = Array.isArray(report.remaining) ? report.remaining.length : 'unknown';
  const needs_followup = report.needs_followup === true || (report.upstreamFixes?.length || 0) > 0;
  const files = candidateFiles(report, options['candidate-root'] || report.candidateRoot);
  if (!files.length) return { has_changes: false, remaining_count, needs_followup };
  assert(options.checkout, 'Trusted checkout required');
  const repo = await metadata(api);
  const base = sha(await ref(api, `heads/${repo.default_branch}`));
  assert(base === sha(process.env.GITHUB_SHA), 'Default branch moved; rerun against its current SHA');
  const local = git(options.checkout, ['rev-parse', 'HEAD']).trim();
  assert(local === base, 'Checkout is not the trusted workflow base');
  const pulls = await api.request(`/pulls?state=open&head=${encodeURIComponent(`${api.repository.split('/')[0]}:${BRANCH}`)}&per_page=100`);
  assert(pulls.length <= 1, 'Multiple automation PRs');
  let pr = pulls[0];
  let orphan = false;
  let closedHistory = [];
  const oldHead = await ref(api, `heads/${BRANCH}`, true);
  if (oldHead) {
    if (pr) {
      owned(pr, api, repo.default_branch);
      assert(pr.head.sha === oldHead, 'PR head changed');
    } else {
      const closed = await api.request(`/pulls?state=closed&head=${encodeURIComponent(`${api.repository.split('/')[0]}:${BRANCH}`)}&sort=updated&direction=desc&per_page=100`);
      closedHistory = closed;
      const prior = closed.find(item => item.merged_at && item.merge_commit_sha === oldHead);
      if (prior) owned(prior, api, repo.default_branch);
      else {
        assert(!closed.some(item => item.head?.sha === oldHead), 'Existing automation branch has a closed PR; refusing to reopen it');
        orphan = true;
      }
    }
    await allowedDiff(api, base, oldHead);
  } else assert(!pr, 'PR branch is missing');
  const baseCommit = await api.request(`/git/commits/${base}`);
  const entries = [];
  for (const file of files) {
    const blob = await api.request('/git/blobs', 'POST', { content: file.content, encoding: 'base64' });
    entries.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const tree = await api.request('/git/trees', 'POST', { base_tree: baseCommit.tree.sha, tree: entries });
  if (tree.sha === baseCommit.tree.sha) return { has_changes: false, remaining_count, needs_followup };
  let head = oldHead;
  const previous = oldHead && await api.request(`/git/commits/${oldHead}`);
  if (orphan) {
    const provenance = await api.request(`/commits/${oldHead}`);
    const priorTip = previous.parents?.[0]?.sha;
    const predecessor = closedHistory.find(item => item.merged_at && item.merge_commit_sha === priorTip);
    if (predecessor) owned(predecessor, api, repo.default_branch);
    const expectedParents = [...new Set([priorTip, base])];
    const originKnown = predecessor || (closedHistory.length === 0 && priorTip === base);
    assert(originKnown && previous.tree.sha === tree.sha && previous.parents?.length === expectedParents.length &&
      previous.parents.every((parent, index) => parent.sha === expectedParents[index]) &&
      previous.message === commitMessage && provenance.author?.id === BOT && provenance.committer?.id === BOT,
    'Orphan branch does not match this exact bot-generated candidate');
  }
  // 同じ候補での再実行は新しいコミットを作らない。
  if (!previous || previous.tree.sha !== tree.sha) {
    const commit = await api.request('/git/commits', 'POST', {
      message: commitMessage, tree: tree.sha,
      parents: [...new Set([oldHead, base].filter(Boolean))],
    });
    head = sha(commit.sha);
    if (oldHead) await api.request(`/git/refs/heads/${BRANCH}`, 'PATCH', { sha: head, force: false });
    else await api.request('/git/refs', 'POST', { ref: `refs/heads/${BRANCH}`, sha: head });
  }
  if (!pr) pr = await api.request('/pulls', 'POST', {
    title: 'fix(deps): Bun の脆弱な依存関係を更新', head: BRANCH, base: repo.default_branch,
    body: `${marker}\nBun audit の修正候補です。固定したマージコミットの CI が成功した場合のみ統合します。`,
  });
  owned(pr, api, repo.default_branch);
  // 仮マージ生成は非同期。旧 ref を誤って検証しないよう親まで照合する。
  let merge;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt) await new Promise(done => setTimeout(done, 3000));
    pr = await api.request(`/pulls/${pr.number}`);
    assert(pr.state === 'open' && pr.head.sha === head && pr.base.sha === base, 'PR changed during preparation');
    const proposed = await ref(api, `pull/${pr.number}/merge`, true);
    if (proposed) {
      const commit = await api.request(`/git/commits/${sha(proposed)}`);
      if (commit.parents?.length === 2 && commit.parents[0].sha === base && commit.parents[1].sha === head) {
        merge = proposed;
        break;
      }
    }
  }
  assert(merge, 'Merge ref is not ready or PR conflicts; rerun workflow');
  return { has_changes: true, remaining_count, needs_followup, pr_number: pr.number, base_branch: repo.default_branch, base_sha: base, head_sha: head, merge_sha: merge };
}
async function exactMerge(api, merge, base, head) {
  const commit = await api.request(`/git/commits/${sha(merge)}`);
  assert(commit.parents?.length === 2 && commit.parents[0].sha === sha(base) && commit.parents[1].sha === sha(head), 'Test merge parents changed');
}
export function validatePush(input, baseRef, base, head, merge) {
  const expected = new Map([[baseRef, sha(base)], [`refs/heads/${BRANCH}`, sha(head)]]);
  const lines = input.trim().split(/\r?\n/).filter(Boolean);
  assert(lines.length === 2, 'Atomic push must update exactly two refs');
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    assert(fields.length === 4, 'Invalid push advertisement');
    const [, local, remote, old] = fields;
    assert(local === sha(merge) && expected.get(remote) === old, 'Remote changed after validation; rerun workflow');
    expected.delete(remote);
  }
  assert(expected.size === 0, 'Missing atomic ref');
}
function git(cwd, args, env = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true });
  assert(result.status === 0, `Git ${args[0]} failed; refusing update`);
  return result.stdout;
}
export function pushMerge({ directory, remote, baseBranch, base, head, merge, token }) {
  const hooks = join(directory, 'hooks');
  mkdirSync(hooks);
  const executable = fileURLToPath(import.meta.url).replaceAll('\\', '/');
  const runtime = process.execPath.replaceAll('\\', '/');
  assert(!/[\n\r']/.test(executable + runtime), 'Unsafe helper path');
  writeFileSync(join(hooks, 'pre-push'), `#!/bin/sh\nexec '${runtime}' '${executable}' check-push\n`, { mode: 0o700 });
  git(directory, ['init', '--bare', '--quiet']);
  const auth = token ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` } : {};
  git(directory, ['-c', 'core.hooksPath=' + hooks, 'fetch', '--no-tags', remote, merge], auth);
  git(directory, ['-c', 'core.hooksPath=' + hooks, 'push', '--atomic', remote,
    `${sha(merge)}:refs/heads/${baseBranch}`, `${sha(merge)}:refs/heads/${BRANCH}`], {
    ...auth, BUN_SECURITY_BASE_REF: `refs/heads/${baseBranch}`, BUN_SECURITY_BASE: sha(base),
    BUN_SECURITY_HEAD: sha(head), BUN_SECURITY_MERGE: sha(merge),
  });
}
export async function duplicateValidationSuite(api, suite, validatedHead) {
  if (suite.app?.slug !== 'github-actions' || suite.conclusion !== 'action_required' || !Number.isSafeInteger(suite.id))
    return { duplicate: false, description: `suite ${suite.id}` };
  const response = await api.request(`/actions/runs?check_suite_id=${suite.id}&per_page=100`);
  const runs = response.workflow_runs;
  if (response.total_count !== 1 || !Array.isArray(runs) || runs.length !== 1)
    return { duplicate: false, description: `suite ${suite.id}: run identity is ambiguous` };
  const run = runs[0];
  const description = `suite ${suite.id}, workflow ${run.workflow_id}, path ${run.path}`;
  if (run.check_suite_id !== suite.id || run.event !== 'pull_request' || run.head_branch !== BRANCH ||
      run.head_sha !== validatedHead || run.repository?.full_name !== api.repository ||
      run.head_repository?.full_name !== api.repository || run.path !== '.github/workflows/dependency-validation.yml' ||
      run.status !== 'completed' || run.conclusion !== 'action_required') return { duplicate: false, description };
  const workflow = await api.request('/actions/workflows/dependency-validation.yml');
  return { duplicate: Number.isSafeInteger(workflow.id) && run.workflow_id === workflow.id &&
    workflow.path === '.github/workflows/dependency-validation.yml', description };
}
async function otherChecks(api, revisions) {
  const run = process.env.GITHUB_RUN_ID;
  const ownPrefix = /^\d+$/.test(run || '') ? `https://github.com/${api.repository}/actions/runs/${run}` : null;
  const current = ownPrefix ? await api.request(`/actions/runs/${run}`) : null;
  for (const revision of new Set(revisions)) {
    for (let page = 1; page <= 10; page++) {
      const response = await api.request(`/commits/${revision}/check-suites?per_page=100&page=${page}`);
      assert(Array.isArray(response.check_suites), 'Cannot inspect check suites');
      for (const suite of response.check_suites) {
        const own = suite.app?.slug === 'github-actions' && suite.id === current?.check_suite_id;
        if (!own && (suite.status !== 'completed' || !['success', 'neutral', 'skipped'].includes(suite.conclusion))) {
          // allowedDiff と trusted needs の全ジョブ成功により、同じ定義・tree の重複だけを代替する。
          const evidence = await duplicateValidationSuite(api, suite, revisions[0]);
          if (!evidence.duplicate) return `Other CI suite is pending, requires approval, or unsuccessful: ${evidence.description}`;
        }
      }
      if (response.check_suites.length < 100) break;
      assert(page < 10, 'Too many check suites to verify safely');
    }
    for (let page = 1; page <= 10; page++) {
      const response = await api.request(`/commits/${revision}/check-runs?filter=latest&per_page=100&page=${page}`);
      assert(Array.isArray(response.check_runs), 'Cannot inspect other check runs');
      for (const check of response.check_runs) {
        const currentRun = ownPrefix && check.app?.slug === 'github-actions' &&
          (check.details_url === ownPrefix || check.details_url?.startsWith(`${ownPrefix}/`));
        if (!currentRun && (check.status !== 'completed' || !['success', 'neutral', 'skipped'].includes(check.conclusion)))
          return 'Other CI check is pending or unsuccessful';
      }
      if (response.check_runs.length < 100) break;
      assert(page < 10, 'Too many check runs to verify safely');
    }
    const combined = await api.request(`/commits/${revision}/status?per_page=100`);
    assert(Array.isArray(combined.statuses) && combined.total_count <= 100, 'Cannot inspect all commit statuses');
    if (combined.statuses.some(status => status.state !== 'success')) return 'Other commit status is pending or unsuccessful';
  }
  return null;
}
export async function merge(api, options) {
  assert(options['validation-success'] === 'true', 'Trusted CI validation did not succeed');
  const base = sha(options['base-sha']), head = sha(options['head-sha']), tested = sha(options['merge-sha']);
  assert(/^\d+$/.test(options.pr ?? ''), 'Invalid PR number');
  const repo = await metadata(api);
  const pr = await api.request(`/pulls/${options.pr}`);
  owned(pr, api, repo.default_branch);
  assert(pr.state === 'open' && !pr.draft && pr.head.sha === head && pr.base.sha === base, 'PR state or commit changed');
  assert(await ref(api, `heads/${repo.default_branch}`) === base && await ref(api, `heads/${BRANCH}`) === head, 'Branch moved');
  assert(await ref(api, `pull/${pr.number}/merge`) === tested, 'Merge ref changed');
  await exactMerge(api, tested, base, head);
  await allowedDiff(api, base, head);
  const branch = await api.request(`/branches/${encodeURIComponent(repo.default_branch)}`);
  const source = await api.request(`/branches/${encodeURIComponent(BRANCH)}`);
  const rules = await api.request(`/rules/branches/${encodeURIComponent(repo.default_branch)}`);
  const sourceRules = await api.request(`/rules/branches/${encodeURIComponent(BRANCH)}`);
  if (branch.protected || source.protected || rules.length || sourceRules.length)
    return { merged: false, hold_reason: 'Branch protection or ruleset requires manual merge' };
  const checkHold = await otherChecks(api, [head, tested]);
  if (checkHold) return { merged: false, hold_reason: checkHold };
  const latest = await api.request(`/pulls/${pr.number}`);
  owned(latest, api, repo.default_branch);
  assert(latest.state === 'open' && !latest.draft && latest.head.sha === head && latest.base.sha === base,
    'PR changed before push');
  assert(options['temp-root'], 'Temporary root required');
  const root = resolve(options['temp-root']);
  assert(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), 'Invalid temporary root');
  const directory = mkdtempSync(join(root, 'bun-security-push-'));
  pushMerge({ directory, remote: `https://github.com/${api.repository}.git`, baseBranch: repo.default_branch, base, head, merge: tested, token: api.token });
  assert(await ref(api, `heads/${repo.default_branch}`) === tested, 'Cannot verify merged default branch');
  let recognized = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt) await new Promise(done => setTimeout(done, 3000));
    if ((await api.request(`/pulls/${pr.number}`)).merged === true) { recognized = true; break; }
  }
  assert(recognized, 'Default branch contains tested merge, but GitHub has not recognized PR as merged');
  return { merged: true, github_pr_merged: true, merge_sha: tested };
}
export async function report(api, options) {
  const result = options.report ? JSON.parse(readFileSync(options.report, 'utf8')) : { status: options.status };
  assert(typeof result.status === 'string', 'Report status required');
  const count = raw => Object.values(raw || {}).reduce((total, entries) => total + (Array.isArray(entries) ? entries.length : 0), 0);
  const audit = {
    status: result.status,
    rawAuditSucceeded: result.status === 'clean' && !!result.rawAfter && count(result.rawAfter) === 0,
    mitigatedCount: Array.isArray(result.mitigations) ? result.mitigations.length : null,
    remainingCount: Array.isArray(result.remaining) ? result.remaining.length : null,
    rawBefore: result.rawBefore, rawAfter: result.rawAfter,
    mitigations: result.mitigations, remaining: result.remaining, error: result.error,
    needs_followup: result.needs_followup, upstreamFixes: result.upstreamFixes,
  };
  if (count(result.rawAfter || result.rawBefore) > 0)
    process.stdout.write('::warning::Raw bun audit still reports advisories; verified mitigations are separate.\n');
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `\n### Bun security audit\n\nKnown mitigations do not turn a failing raw audit into a successful raw audit.\n\n\`\`\`json\n${JSON.stringify(audit, null, 2)}\n\`\`\`\n`);
  const repo = await metadata(api);
  const diagnostics = JSON.stringify({ remaining: result.remaining, error: result.error,
    needs_followup: result.needs_followup, upstreamFixes: result.upstreamFixes,
    nativeFix: result.nativeFix && { exitCode: result.nativeFix.exitCode, stderr: result.nativeFix.stderr } }, null, 2);
  const prLink = /^\d+$/.test(options.pr || '') ? `\nPR: https://github.com/${api.repository}/pull/${options.pr}\n` : '';
  const body = `${marker}\nBun security automation: ${String(result.status)}\n\nRemaining advisories: ${Array.isArray(result.remaining) ? result.remaining.length : 'see workflow summary'}\n\n${String(options.details || '')}${prLink}\n\nWorkflow: https://github.com/${api.repository}/actions/runs/${process.env.GITHUB_RUN_ID || ''}\n\n\`\`\`json\n${diagnostics.slice(0, 50000)}\n\`\`\`\nFull unfiltered audit is in the workflow summary.`;
  if (!repo.has_issues) return { issue_reporting: 'disabled' };
  let existing;
  for (let page = 1; page <= 10; page++) {
    const issues = await api.request(`/issues?state=open&creator=github-actions%5Bbot%5D&per_page=100&page=${page}`);
    assert(Array.isArray(issues), 'Cannot inspect existing notification');
    existing = issues.find(issue => !issue.pull_request && issue.user?.id === BOT && issue.body?.startsWith(marker));
    if (existing || issues.length < 100) break;
    assert(page < 10, 'Too many issues to deduplicate safely');
  }
  const problem = result.needs_followup === true || result.upstreamFixes?.length > 0 || result.remaining?.length || ['unfixable', 'blocked', 'error', 'validation-failed', 'prepare-failed', 'merge-failed'].includes(result.status);
  if (!problem) {
    // 監査の clean/mitigated は既存 PR の CI 成功を証明しない。
    let resolved = result.status === 'resolved';
    if (existing && !resolved && ['clean', 'mitigated'].includes(result.status) &&
        result.remaining?.length === 0 && result.result_changed === false) {
      const open = await api.request(`/pulls?state=open&head=${encodeURIComponent(`${api.repository.split('/')[0]}:${BRANCH}`)}&per_page=100`);
      assert(Array.isArray(open), 'Cannot verify pending security PRs');
      resolved = open.length === 0;
    }
    if (existing && resolved) await api.request(`/issues/${existing.number}`, 'PATCH', { state: 'closed' });
    return { issue_reporting: existing && !resolved ? 'unchanged' : 'clear' };
  }
  const payload = { title: 'Bun: 自動修正できない脆弱性の確認', body };
  const issue = existing ? await api.request(`/issues/${existing.number}`, 'PATCH', payload) : await api.request('/issues', 'POST', payload);
  return { issue_number: issue.number };
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'check-push') {
    validatePush(readFileSync(0, 'utf8'), process.env.BUN_SECURITY_BASE_REF, process.env.BUN_SECURITY_BASE,
      process.env.BUN_SECURITY_HEAD, process.env.BUN_SECURITY_MERGE);
    return;
  }
  assert(['prepare', 'merge', 'report'].includes(command) && args.length % 2 === 0, 'Expected prepare, merge or report with --key value arguments');
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    assert(/^--[a-z-]+$/.test(args[index]), 'Invalid option');
    options[args[index].slice(2)] = args[index + 1];
  }
  output(await ({ prepare, merge, report })[command](client(), options));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
