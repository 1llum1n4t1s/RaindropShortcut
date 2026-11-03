import { test, expect } from 'bun:test';
import { mkdirSync, writeFileSync, existsSync, readFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseAudit, parseNativeFix, upstreamMitigationFixes, validateReduction, validateManifest, validateProtectedFiles, validateNoDowngrades, validateReleaseAge, maintain, safePath } from './Maintain-Security.mjs';

const lock = versions => ({ workspaces: { '': {} }, packages: Object.fromEntries(versions.map(([slot, name, version]) => [slot, [`${name}@${version}`, '', {}, 'sha512-fixture']])) });
test('監査JSONの前置きを許容し、欠落や不正データを成功扱いにしない', () => {
  expect(parseAudit('Bun audit\n{}\n')).toEqual({});
  expect(() => parseAudit('request failed')).toThrow();
  expect(() => parseAudit('{"error":"network"}')).toThrow();
});
test('scripts、信頼リスト、packageManager、patch定義の変更を拒否', () => {
  const original = { scripts: { test: 'bun test' }, packageManager: 'bun@1.4.4', trustedDependencies: [], patchedDependencies: { 'x@1': 'patches/x.patch' }, dependencies: { x: '1' } };
  validateManifest(original, { ...original, dependencies: { x: '2.0.0' } });
  for (const mutation of [{ scripts: { postinstall: 'poison' } }, { packageManager: 'npm@1' }, { trustedDependencies: ['x'] }, { patchedDependencies: {} }]) expect(() => validateManifest(original, { ...original, ...mutation })).toThrow();
});
test('依存名の変更、URL、非脆弱依存のoverride追加、削除を拒否', () => {
  const original = { dependencies: { x: '1.0.0' } };
  for (const dependencies of [{ y: '2.0.0' }, {}, { x: 'https://evil.invalid/x.tgz' }, { x: 'file:../x' }, { x: 'npm:y@1.0.0' }]) expect(() => validateManifest(original, { dependencies })).toThrow();
  expect(() => validateManifest(original, { ...original, overrides: { y: '2.0.0' } }, new Set(['x']))).toThrow();
  validateManifest(original, { ...original, overrides: { x: '2.0.0' } }, new Set(['x']));
});
test('native計画のJSON、downgrade、公開待機期間と厳密な監査削減を検証', () => {
  const plan = { dryRun: true, fixed: 1, remaining: 0, fixes: [{ name: 'x', from: '1.0.0', to: '2.0.0', downgrade: false }], blocked: [], unfixable: [] };
  expect(parseNativeFix(`Bun audit\n${JSON.stringify(plan)}`)).toEqual(plan);
  expect(() => parseNativeFix(JSON.stringify({ ...plan, fixes: [{ ...plan.fixes[0], downgrade: true }] }))).toThrow();
  expect(() => parseNativeFix(JSON.stringify({ ...plan, fixes: [{ ...plan.fixes[0], newerThanMinimumReleaseAge: true }] }))).toThrow();
  expect(() => parseNativeFix('failed')).toThrow();
  const advisory = { package: 'x', url: 'GHSA-x' };
  expect(() => validateReduction([advisory], [advisory], true)).toThrow();
  expect(() => validateReduction([advisory], [{ package: 'y', url: 'GHSA-y' }], true)).toThrow();
  validateReduction([advisory], [], true);
});
test('対策済み依存の公式新版だけを監視し、downgradeを毎日通知しない', () => {
  const verified = [{ package: 'deepmerge', version: '4.3.1', advisory: 'GHSA-reviewed' }];
  const oldPlan = { dryRun: true, fixed: 0, remaining: 1, fixes: [], blocked: [{ name: 'deepmerge', from: '4.3.1', to: '4.1.2', downgrade: true }], unfixable: [] };
  expect(upstreamMitigationFixes(parseNativeFix(JSON.stringify(oldPlan), { allowUnsafe: true }), verified)).toEqual([]);
  const newer = { name: 'deepmerge', from: '4.3.1', to: '4.3.2', downgrade: false };
  expect(upstreamMitigationFixes({ ...oldPlan, fixes: [newer] }, verified).length).toBe(1);
  expect(upstreamMitigationFixes({ ...oldPlan, blocked: [newer] }, verified).length).toBe(1);
  expect(upstreamMitigationFixes({ ...oldPlan, fixes: [{ ...newer, name: 'other' }] }, verified)).toEqual([]);
});
test('同じslotと移動先slotのダウングレードを拒否', () => {
  const original = lock([['x', 'x', '4.3.1']]);
  expect(() => validateNoDowngrades(original, lock([['x', 'x', '4.1.2']]))).toThrow();
  expect(() => validateNoDowngrades(original, lock([['nested/x', 'x', '4.1.2']]))).toThrow();
  validateNoDowngrades(original, lock([['x', 'x', '4.3.2']]));
  const multiple = lock([['x', 'x', '1.0.0'], ['a/x', 'x', '3.0.0']]);
  expect(() => validateNoDowngrades(multiple, lock([['x', 'x', '1.0.0'], ['b/x', 'x', '2.0.0']]))).toThrow();
  expect(() => validateNoDowngrades(multiple, lock([['x', 'x', '1.0.0'], ['b/x', 'x', '1.0.0']]))).toThrow();
  validateNoDowngrades(multiple, lock([['x', 'x', '1.0.0'], ['b/x', 'x', '3.0.0']]));
});
test('全新規バージョンの公開時刻を確認し、既存完全一致の除外だけ許可', async () => {
  const before = lock([['x', 'x', '1.0.0']]), after = lock([['x', 'x', '1.0.1']]);
  const now = Date.now(), times = async () => ({ '1.0.1': new Date(now - 1000).toISOString() });
  await expect(validateReleaseAge(before, after, {}, times, now)).rejects.toThrow();
  await expect(validateReleaseAge(before, after, { minimumReleaseAgeExcludes: ['*'] }, times, now)).rejects.toThrow();
  await validateReleaseAge(before, after, { minimumReleaseAgeExcludes: ['x'] }, times, now);
  await validateReleaseAge(before, after, {}, async () => ({ '1.0.1': new Date(now - 86401000).toISOString() }), now);
  await expect(validateReleaseAge(before, after, {}, async () => ({}), now)).rejects.toThrow();
});
test('領域外パスを拒否', () => expect(() => safePath(resolve('.'), '../poison')).toThrow());
test('パッチ内容、lock内パッチ定義、bunfigの変化を拒否', () => {
  const before = { manifests: ['package.json'], lock: { patchedDependencies: { 'x@1': 'patches/x.patch' } }, bytes: new Map([['patches/x.patch', Buffer.from('approved')], ['bunfig.toml', Buffer.from('minimumReleaseAge = 86400')]]) };
  validateProtectedFiles(before, before);
  for (const path of ['patches/x.patch', 'bunfig.toml']) {
    const bytes = new Map(before.bytes); bytes.set(path, Buffer.from('changed'));
    expect(() => validateProtectedFiles(before, { ...before, bytes })).toThrow();
  }
  expect(() => validateProtectedFiles(before, { ...before, lock: { patchedDependencies: {} } })).toThrow();
  expect(() => validateProtectedFiles(before, { ...before, lock: { ...before.lock, trustedDependencies: ['poison'] } })).toThrow();
});

// 実ネットワークを伴うケースは明示指定した隔離領域にだけ出力する。
const integrationRoot = process.env.BUN_SECURITY_INTEGRATION_ROOT;
if (integrationRoot) {
  test('実際のminimatch脆弱版を修正しpostinstallを実行しない', async () => {
    const root = join(integrationRoot, `minimatch-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'security-engine-fixture', packageManager: `bun@${Bun.version}`, dependencies: { minimatch: '3.0.4' }, scripts: { postinstall: 'bun -e "Bun.write(\'POISON\', \'executed\')"' } }, null, 2));
    writeFileSync(join(root, 'bunfig.toml'), '[install]\nminimumReleaseAge = 86400\n');
    const result = Bun.spawnSync({ cmd: [process.execPath, 'install', '--ignore-scripts', '--lockfile-only'], cwd: root, env: { ...process.env, TEMP: integrationRoot, TMP: integrationRoot }, stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(0);
    const report = await maintain({ repo: root, tempRoot: integrationRoot, mode: 'fix' });
    expect(Object.keys(report.rawBefore)).toContain('minimatch');
    expect(report.result_changed).toBe(true);
    expect(report.remaining).toEqual([]);
    expect(existsSync(join(report.candidateRoot, 'node_modules'))).toBe(false);
    expect(existsSync(join(report.candidateRoot, 'POISON'))).toBe(false);
    expect(JSON.parse(readFileSync(join(report.candidateRoot, 'package.json'))).scripts).toEqual(JSON.parse(readFileSync(join(root, 'package.json'))).scripts);
    expect(JSON.parse(readFileSync(join(root, 'package.json'))).dependencies.minimatch).toBe('3.0.4');
    writeFileSync(join(root, 'bunfig.toml'), '[install]\nminimumReleaseAge = 0\n');
    let rejected;
    try { await maintain({ repo: root, tempRoot: integrationRoot, mode: 'fix' }); } catch (error) { rejected = error.report; }
    expect(rejected.status).toBe('error');
    expect(rejected.rawBefore.minimatch.length).toBeGreaterThan(0);
    expect(rejected.nativePlan.fixes.length).toBeGreaterThan(0);
    expect(rejected.rawAfter).toBeNull();
    expect(rejected.changedFiles).toEqual([]);
    expect(rejected.result_changed).toBe(false);
  }, 180000);
  const deepmergeRepo = process.env.BUN_SECURITY_DEEPMERGE_REPO;
  if (deepmergeRepo) test('deepmerge対策と他CVEの混在でも修正を進め、生のLowを残す', async () => {
    const root = join(integrationRoot, `mixed-${Date.now()}`);
    mkdirSync(join(root, 'patches'), { recursive: true });
    copyFileSync(join(deepmergeRepo, 'patches/deepmerge@4.3.1.patch'), join(root, 'patches/deepmerge@4.3.1.patch'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'mixed-security-fixture', packageManager: `bun@${Bun.version}`, dependencies: { minimatch: '3.0.4', deepmerge: '4.3.1' }, patchedDependencies: { 'deepmerge@4.3.1': 'patches/deepmerge@4.3.1.patch' } }, null, 2));
    writeFileSync(join(root, 'bunfig.toml'), '[install]\nminimumReleaseAge = 86400\n');
    const result = Bun.spawnSync({ cmd: [process.execPath, 'install', '--ignore-scripts', '--lockfile-only'], cwd: root, env: { ...process.env, TEMP: integrationRoot, TMP: integrationRoot }, stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(0);
    const report = await maintain({ repo: root, tempRoot: integrationRoot, mode: 'fix' });
    expect(report.result_changed).toBe(true);
    expect(report.status).toBe('mitigated');
    expect(report.rawBefore.minimatch.length).toBeGreaterThan(0);
    expect(report.rawAfter.deepmerge.length).toBe(1);
    expect(report.rawAfter.minimatch).toBeUndefined();
    expect(report.remediationIgnores).toEqual(['GHSA-gcqx-w48m-w2h4']);
    expect(report.remaining).toEqual([]);
    expect(JSON.parse(readFileSync(join(report.candidateRoot, 'package.json'))).dependencies.deepmerge).toBe('4.3.1');
  }, 180000);
  if (deepmergeRepo) test('実際のdeepmergeパッチは生監査を保持しダウングレードを提案しない', async () => {
    const report = await maintain({ repo: deepmergeRepo, tempRoot: integrationRoot, mode: 'fix' });
    expect(report.status).toBe('mitigated');
    expect(report.rawBefore.deepmerge.length).toBe(1);
    expect(report.rawAfter.deepmerge.length).toBe(1);
    expect(report.mitigations.length).toBe(1);
    expect(report.result_changed).toBe(false);
    expect(report.nativeFix).toBeUndefined();
    expect(report.mitigationPlan.blocked[0].to).toBe('4.1.2');
    expect(report.upstreamFixes).toEqual([]);
    expect(report.needs_followup).toBe(false);
  }, 180000);
}
