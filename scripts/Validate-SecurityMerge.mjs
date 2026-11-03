import { pathToFileURL } from 'node:url';

// 既定ブランチから実行し、候補コードを読み込む前に API 上の信頼境界を確認する。
export async function validateSecurityMerge(env = process.env, request = fetch) {
  const { GH_TOKEN: token, GITHUB_REPOSITORY: repo, PR_NUMBER: number,
    BASE_SHA: base, HEAD_SHA: head, MERGE_SHA: merge } = env;
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !/^[1-9][0-9]*$/.test(number ?? '') ||
      ![base, head, merge].every(value => /^[0-9a-f]{40}$/.test(value ?? ''))) {
    throw new Error('Security validation inputs are invalid');
  }
  async function get(path) {
    const response = await request(`https://api.github.com/repos/${repo}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!response.ok) throw new Error(`GitHub API failed (${response.status})`);
    return response.json();
  }
  const repository = await get('');
  const pr = await get(`/pulls/${number}`);
  const branch = await get(`/branches/${encodeURIComponent(repository.default_branch)}`);
  const ref = await get(`/git/ref/pull/${number}/merge`);
  if (repository.full_name !== repo || pr.state !== 'open' || pr.draft ||
      pr.user?.id !== 41898282 || pr.user?.login !== 'github-actions[bot]' || pr.user?.type !== 'Bot' ||
      pr.head?.ref !== 'automation/bun-security' || pr.head?.repo?.id !== repository.id ||
      pr.base?.repo?.id !== repository.id || pr.base?.ref !== repository.default_branch ||
      branch.commit?.sha !== base || pr.base?.sha !== base || pr.head?.sha !== head ||
      pr.mergeable !== true || pr.merge_commit_sha !== merge || ref.object?.sha !== merge) {
    throw new Error('Security PR identity, base, head or merge changed');
  }
  console.log(`Validated security PR #${number} at ${merge}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await validateSecurityMerge();
}
