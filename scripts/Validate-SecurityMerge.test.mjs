import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateSecurityMerge } from './Validate-SecurityMerge.mjs';

const env = {
  GH_TOKEN: 'fixture-token', GITHUB_REPOSITORY: 'owner/repo', PR_NUMBER: '7',
  BASE_SHA: 'a'.repeat(40), HEAD_SHA: 'b'.repeat(40), MERGE_SHA: 'c'.repeat(40),
};
const good = [
  { id: 1, full_name: 'owner/repo', default_branch: 'main' },
  {
    state: 'open', draft: false,
    user: { id: 41898282, login: 'github-actions[bot]', type: 'Bot' },
    head: { ref: 'automation/bun-security', sha: env.HEAD_SHA, repo: { id: 1 } },
    base: { ref: 'main', sha: env.BASE_SHA, repo: { id: 1 } },
    mergeable: true, merge_commit_sha: env.MERGE_SHA,
  },
  { commit: { sha: env.BASE_SHA } }, { object: { sha: env.MERGE_SHA } },
];

async function check(data, overrides = {}, status = 200) {
  const paths = ['', '/pulls/7', '/branches/main', '/git/ref/pull/7/merge'];
  let calls = 0;
  await validateSecurityMerge({ ...env, ...overrides }, async (url, options) => {
    assert.equal(url, `https://api.github.com/repos/owner/repo${paths[calls]}`);
    assert.equal(options.headers.authorization, 'Bearer fixture-token');
    return { ok: status === 200, status, json: async () => data[calls++] };
  });
  assert.equal(calls, 4);
}

test('現在の同一 repo の security bot PR と merge を受け付ける', async () => {
  await check(good);
});

test('本人性・ブランチ・base/head/merge の変化を拒否する', async () => {
  const mutations = [
    x => x[0].full_name = 'other/repo', x => x[1].state = 'closed', x => x[1].draft = true,
    x => x[1].user.id = 49699333, x => x[1].user.login = 'other', x => x[1].user.type = 'User',
    x => x[1].head.ref = 'automation/bun-security-evil', x => x[1].head.repo.id = 2,
    x => x[1].base.repo.id = 2, x => x[1].base.ref = 'release', x => x[1].base.sha = 'd'.repeat(40),
    x => x[1].head.sha = 'd'.repeat(40), x => x[1].mergeable = null,
    x => x[1].merge_commit_sha = 'd'.repeat(40), x => x[2].commit.sha = 'd'.repeat(40),
    x => x[3].object.sha = 'd'.repeat(40),
  ];
  for (const mutate of mutations) {
    const data = structuredClone(good);
    mutate(data);
    await assert.rejects(check(data), /Security PR identity, base, head or merge changed/);
  }
});

test('不正入力は API を呼び出す前に拒否する', async () => {
  for (const overrides of [
    { PR_NUMBER: '7;echo unsafe' }, { BASE_SHA: 'invalid' }, { HEAD_SHA: '' },
    { MERGE_SHA: '' }, { GITHUB_REPOSITORY: 'owner/repo/extra' }, { GH_TOKEN: '' },
  ]) {
    let calls = 0;
    await assert.rejects(validateSecurityMerge({ ...env, ...overrides }, async () => {
      calls++;
      throw new Error('Unexpected API request');
    }), /Security validation inputs are invalid/);
    assert.equal(calls, 0);
  }
});

test('API の拒否を成功扱いしない', async () => {
  await assert.rejects(check(good, {}, 403), /GitHub API failed \(403\)/);
});
