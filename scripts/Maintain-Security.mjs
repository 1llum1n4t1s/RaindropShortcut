// 監査の生データを残し、隔離領域で検証した依存変更だけを返す。
import { readFileSync, writeFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, copyFileSync } from 'node:fs';
import { resolve, dirname, relative, join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

export const DEEPMERGE_PATCH_SHA256 = 'e1cf4034d5937eaf5f63539465be222e31805864ea6227ed44078d966d95d0d0';
const advisoryURL = 'https://github.com/advisories/GHSA-gcqx-w48m-w2h4';
const dependencyKeys = new Set(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides', 'resolutions']);
const hash = value => createHash('sha256').update(value).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const lockAt = root => Bun.JSON5.parse(readFileSync(join(root, 'bun.lock'), 'utf8'));
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function safePath(root, path) {
  const absolute = resolve(root, path);
  const rel = relative(resolve(root), absolute);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../')) throw new Error(`領域外のパス: ${path}`);
  let current = absolute;
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`リンクは扱えません: ${current}`);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return absolute;
}
export function parseAudit(stdout) {
  // Bun が前置きのメッセージを出す版でも、末尾の完全なJSONだけを読む。
  const text = String(stdout).trim();
  try { return validateAudit(JSON.parse(text)); } catch {}
  for (const line of text.split(/\r?\n/).reverse()) {
    try { return validateAudit(JSON.parse(line)); } catch {}
  }
  throw new Error('bun audit のJSONを取得できませんでした');
}
function validateAudit(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.values(value).some(items => !Array.isArray(items) || items.some(item => !item.url || !item.severity))) throw new Error('監査形式が不正です');
  return value;
}
export function packages(lock) {
  if (!lock.packages || !lock.workspaces) throw new Error('bun.lock の形式が不正です');
  return Object.entries(lock.packages).map(([slot, entry]) => {
    const match = typeof entry?.[0] === 'string' && entry[0].match(/^(.+)@(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)$/);
    return { slot, name: match?.[1], version: match?.[2], resolution: entry?.[0] };
  });
}
export function validateManifest(before, after, vulnerableNames = new Set()) {
  const immutable = value => Object.fromEntries(Object.entries(value).filter(([key]) => !dependencyKeys.has(key)));
  if (!same(immutable(before), immutable(after))) throw new Error('依存以外のmanifest変更を拒否しました');
  for (const key of dependencyKeys) {
    if (after[key] !== undefined && (!after[key] || typeof after[key] !== 'object' || Array.isArray(after[key]))) throw new Error(`依存定義の形式が不正です: ${key}`);
    const old = before[key] ?? {}, next = after[key] ?? {};
    for (const name of Object.keys(old)) if (!Object.hasOwn(next, name)) throw new Error(`依存の削除を拒否しました: ${name}`);
    for (const [name, range] of Object.entries(next)) {
      if (same(old[name], range)) continue;
      if (!Object.hasOwn(old, name) && (!(key === 'overrides' || key === 'resolutions') || !vulnerableNames.has(name))) throw new Error(`依存の追加を拒否しました: ${name}`);
      if (typeof range !== 'string' || !/^[~^<>=\s]*\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?(?:\s*(?:\|\||-|[<>=])\s*\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)*$/.test(range)) throw new Error(`registry以外または不正な依存指定を拒否しました: ${name}`);
    }
  }
}
export function validateProtectedFiles(before, after) {
  for (const [path, bytes] of before.bytes) {
    if (!before.manifests.includes(path) && path !== 'bun.lock' && (!after.bytes.has(path) || !bytes.equals(after.bytes.get(path)))) throw new Error(`保護ファイルが変更されました: ${path}`);
  }
  if (!same(before.lock.patchedDependencies, after.lock.patchedDependencies)) throw new Error('lockfile のパッチ定義が変更されました');
  const mutableLockKeys = new Set(['packages', 'workspaces', 'overrides', 'resolutions']);
  const fixedLockFields = value => Object.fromEntries(Object.entries(value).filter(([key]) => !mutableLockKeys.has(key)));
  if (!same(fixedLockFields(before.lock), fixedLockFields(after.lock))) throw new Error('lockfile の保護設定が変更されました');
  if (!same(Object.keys(before.lock.workspaces ?? {}).sort(), Object.keys(after.lock.workspaces ?? {}).sort())) throw new Error('workspace一覧が変更されました');
  for (const workspace of Object.keys(before.lock.workspaces ?? {})) validateManifest(before.lock.workspaces[workspace], after.lock.workspaces[workspace]);
}
export function validateNoDowngrades(before, after) {
  const old = packages(before), next = packages(after);
  for (const name of new Set(old.filter(pkg => pkg.version).map(pkg => pkg.name))) {
    const previous = old.filter(pkg => pkg.name === name && pkg.version);
    const following = next.filter(pkg => pkg.name === name && pkg.version);
    const count = (items, version) => items.filter(pkg => pkg.version === version).length;
    const removed = previous.filter(pkg => count(previous, pkg.version) > count(following, pkg.version));
    const added = following.filter(pkg => count(following, pkg.version) > count(previous, pkg.version));
    if (added.some(pkg => removed.some(item => Bun.semver.order(pkg.version, item.version) < 0))) throw new Error(`配置移動によるダウングレードを拒否しました: ${name}`);
  }
  for (const pkg of next) {
    const previous = old.find(item => item.slot === pkg.slot && item.name === pkg.name);
    if (previous?.version && pkg.version && Bun.semver.order(pkg.version, previous.version) < 0) throw new Error(`ダウングレードを拒否しました: ${pkg.name} ${previous.version} -> ${pkg.version}`);
    // 別slotへの移動で古いバージョンを導入する経路も拒否する。
    const existing = old.filter(item => item.name === pkg.name && item.version);
    if (pkg.version && existing.length && !existing.some(item => item.version === pkg.version) && existing.some(item => Bun.semver.order(pkg.version, item.version) < 0)) throw new Error(`旧版の追加を拒否しました: ${pkg.name}@${pkg.version}`);
    if (!pkg.version && !old.some(item => item.slot === pkg.slot && item.resolution === pkg.resolution)) throw new Error(`公開時刻を確認できない新規依存: ${pkg.resolution}`);
  }
}
export async function validateReleaseAge(before, after, policy, getTimes, now = Date.now()) {
  const known = new Set(packages(before).map(pkg => `${pkg.name}@${pkg.version}`));
  const checked = new Set();
  const age = policy.minimumReleaseAge ?? 86400;
  if (!Number.isFinite(age) || age < 86400) throw new Error('minimumReleaseAge は24時間以上必要です');
  for (const pkg of packages(after)) {
    const key = `${pkg.name}@${pkg.version}`;
    if (!pkg.version || known.has(key) || checked.has(key)) continue;
    checked.add(key);
    // globやscope全体を新たな除外として解釈しない。既存の完全一致だけ許可する。
    if ((policy.minimumReleaseAgeExcludes ?? []).includes(pkg.name) || (policy.minimumReleaseAgeExcludes ?? []).includes(key)) continue;
    const time = Date.parse((await getTimes(pkg.name))[pkg.version]);
    if (!Number.isFinite(time) || now - time < age * 1000) throw new Error(`公開待機期間を満たしていません: ${key}`);
  }
}
export function mitigations(root, audit, lock = lockAt(root)) {
  const manifest = json(join(root, 'package.json'));
  const patch = manifest.patchedDependencies?.['deepmerge@4.3.1'];
  if (!patch || lock.patchedDependencies?.['deepmerge@4.3.1'] !== patch) return [];
  const path = safePath(root, patch);
  if (!existsSync(path) || hash(readFileSync(path)) !== DEEPMERGE_PATCH_SHA256) return [];
  const versions = packages(lock).filter(pkg => pkg.name === 'deepmerge');
  if (!versions.length || versions.some(pkg => pkg.version !== '4.3.1')) return [];
  return (audit.deepmerge ?? []).filter(item => item.url === advisoryURL && item.vulnerable_versions === '>=4.2.0 <=4.3.1').map(item => ({ package: 'deepmerge', advisory: item.url, version: '4.3.1', patch, sha256: DEEPMERGE_PATCH_SHA256 }));
}
export function remainingAdvisories(audit, verified) {
  return Object.entries(audit).flatMap(([name, entries]) => entries.filter(item => !verified.some(m => m.package === name && m.advisory === item.url)).map(item => ({ package: name, ...item })));
}
export function parseNativeFix(stdout, { allowUnsafe = false } = {}) {
  for (const line of String(stdout).trim().split(/\r?\n/).reverse()) {
    let value;
    try { value = JSON.parse(line); } catch { continue; }
    if (typeof value.dryRun !== 'boolean' || !Number.isInteger(value.fixed) || value.fixed < 0 || !Number.isInteger(value.remaining) || value.remaining < 0 || !Array.isArray(value.fixes) || !Array.isArray(value.blocked) || !Array.isArray(value.unfixable)) throw new Error('native修正計画の形式が不正です');
    for (const fix of value.fixes) {
      if (typeof fix.name !== 'string' || typeof fix.from !== 'string' || typeof fix.to !== 'string' || typeof fix.downgrade !== 'boolean') throw new Error('native修正内容の形式が不正です');
      if (!allowUnsafe && (fix.downgrade || Bun.semver.order(fix.to, fix.from) < 0)) throw new Error(`native修正計画のダウングレードを拒否しました: ${fix.name}`);
      if (!allowUnsafe && fix.newerThanMinimumReleaseAge) throw new Error(`native修正計画が公開待機期間を満たしていません: ${fix.name}`);
    }
    return value;
  }
  throw new Error('native修正計画のJSONを取得できませんでした');
}
export function upstreamMitigationFixes(plan, verified) {
  return [...plan.fixes, ...plan.blocked].filter(fix => verified.some(item => item.package === fix.name && item.version === fix.from) && typeof fix.to === 'string' && !fix.downgrade && Bun.semver.order(fix.to, fix.from) > 0).map(fix => ({ ...fix, advisory: verified.find(item => item.package === fix.name).advisory }));
}
export function validateReduction(before, after, changed) {
  if (after.some(item => !before.some(old => old.package === item.package && old.url === item.url))) throw new Error('候補で新しい未対策の脆弱性が発生しました');
  if (changed && after.length >= before.length) throw new Error('未対策の脆弱性が減らない候補変更を拒否しました');
}
function run(root, args, tempRoot) {
  const result = Bun.spawnSync({ cmd: [process.execPath, ...args], cwd: root, env: { ...process.env, TEMP: tempRoot, TMP: tempRoot }, stdout: 'pipe', stderr: 'pipe', timeout: 180000 });
  if (result.error) throw result.error;
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}
function audit(root, tempRoot) {
  const result = run(root, ['audit', '--json'], tempRoot);
  if (![0, 1].includes(result.exitCode)) throw new Error(`bun audit 失敗: ${result.stderr}`);
  return parseAudit(result.stdout);
}
async function registryTimes(name) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`公開時刻の取得失敗: ${name} HTTP ${response.status}`);
  const result = await response.json();
  if (!result.time) throw new Error(`公開時刻がありません: ${name}`);
  return result.time;
}
function snapshot(root) {
  const lock = lockAt(root);
  const manifests = Object.keys(lock.workspaces).map(workspace => workspace ? `${workspace}/package.json` : 'package.json');
  const files = new Set(['bun.lock', ...manifests]);
  for (const manifest of manifests) {
    const data = json(safePath(root, manifest));
    for (const patch of Object.values(data.patchedDependencies ?? {})) files.add(patch);
  }
  for (const path of Object.values(lock.patchedDependencies ?? {})) files.add(path);
  if (existsSync(join(root, 'bunfig.toml'))) files.add('bunfig.toml');
  const bytes = new Map([...files].map(path => [path, readFileSync(safePath(root, path))]));
  return { lock, manifests, bytes };
}
function copy(root, files) {
  for (const [path, bytes] of files) {
    const destination = safePath(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }
}
export async function maintain({ repo, tempRoot, mode = 'inspect', apply = false }) {
  if (!isAbsolute(repo) || !isAbsolute(tempRoot)) throw new Error('repo/temp-root は絶対パスが必要です');
  safePath(repo, '.'); safePath(tempRoot, '.');
  if (!existsSync(tempRoot)) throw new Error('temp-root は事前に作成してください');
  const before = snapshot(repo);
  const rootManifest = json(join(repo, 'package.json'));
  if (rootManifest.packageManager !== `bun@${Bun.version}`) throw new Error('packageManager と実行Bunが一致しません');
  const candidateRoot = mkdtempSync(join(tempRoot, 'candidate-'));
  copy(candidateRoot, before.bytes);
  const rawBefore = audit(candidateRoot, tempRoot);
  const initialMitigations = mitigations(candidateRoot, rawBefore, before.lock);
  const report = { schemaVersion: 1, repo, candidateRoot, status: 'unchanged', result_changed: false, changedFiles: [], rawBefore, rawAfter: rawBefore, mitigations: initialMitigations, remaining: remainingAdvisories(rawBefore, initialMitigations), applied: false, upstreamFixes: [], needs_followup: false };
  try {
  if (initialMitigations.length) {
    const probe = run(candidateRoot, ['audit', 'fix', '--latest', '--json', '--dry-run', '--ignore-scripts', '--lockfile-only'], tempRoot);
    report.mitigationProbe = probe;
    if (![0, 1].includes(probe.exitCode)) throw new Error(`公式修正版の監視失敗: ${probe.stderr}`);
    report.mitigationPlan = parseNativeFix(probe.stdout, { allowUnsafe: true });
    report.upstreamFixes = upstreamMitigationFixes(report.mitigationPlan, initialMitigations);
    report.needs_followup = report.upstreamFixes.length > 0;
  }
  if (mode === 'inspect' || !report.remaining.length) {
    report.status = report.remaining.length ? 'remaining' : initialMitigations.length ? 'mitigated' : 'clean';
    return report;
  }
  if (mode !== 'fix') throw new Error(`不明なmode: ${mode}`);
  // 生の監査は常に除外なし。完全一致で検証済みの対策だけ修正計画から外す。
  const remediationIgnores = [...new Set(initialMitigations.map(item => item.advisory.split('/').pop()))];
  const fixArgs = ['audit', 'fix', '--latest', '--ignore-scripts', '--lockfile-only', '--json', ...remediationIgnores.flatMap(id => ['--ignore', id])];
  report.remediationIgnores = remediationIgnores;
  const planned = run(candidateRoot, [...fixArgs, '--dry-run'], tempRoot);
  report.nativePlanOutput = planned;
  if (![0, 1].includes(planned.exitCode)) throw new Error(`bun audit fix 計画失敗: ${planned.stderr}`);
  report.nativePlan = parseNativeFix(planned.stdout);
  const fixed = run(candidateRoot, fixArgs, tempRoot);
  report.nativeFix = fixed;
  report.rawAfter = null;
  if (![0, 1].includes(fixed.exitCode)) throw new Error(`bun audit fix 失敗: ${fixed.stderr}`);
  report.nativeResult = parseNativeFix(fixed.stdout);
  if (existsSync(join(candidateRoot, 'node_modules'))) throw new Error('lockfile-only で node_modules が生成されました');
  const after = snapshot(candidateRoot);
  const vulnerableNames = new Set(Object.keys(rawBefore));
  for (const path of before.manifests) validateManifest(JSON.parse(before.bytes.get(path)), json(join(candidateRoot, path)), vulnerableNames);
  validateProtectedFiles(before, after);
  validateNoDowngrades(before.lock, after.lock);
  const policy = before.bytes.has('bunfig.toml') ? Bun.TOML.parse(before.bytes.get('bunfig.toml').toString()).install ?? {} : {};
  await validateReleaseAge(before.lock, after.lock, policy, registryTimes);
  report.rawAfter = audit(candidateRoot, tempRoot);
  report.mitigations = mitigations(candidateRoot, report.rawAfter, after.lock);
  report.remaining = remainingAdvisories(report.rawAfter, report.mitigations);
  const originalRemaining = remainingAdvisories(rawBefore, initialMitigations);
  report.changedFiles = [...after.bytes].filter(([path, bytes]) => !before.bytes.get(path)?.equals(bytes)).map(([path]) => path);
  if (report.changedFiles.some(path => path !== 'bun.lock' && !before.manifests.includes(path))) throw new Error('許可外の候補変更がありました');
  report.result_changed = report.changedFiles.length > 0;
  validateReduction(originalRemaining, report.remaining, report.result_changed);
  report.status = report.remaining.length ? 'remaining' : report.mitigations.length ? 'mitigated' : 'clean';
  if (apply && report.result_changed) {
    for (const [path, bytes] of before.bytes) if (!readFileSync(safePath(repo, path)).equals(bytes)) throw new Error(`実行中に元ファイルが変更されました: ${path}`);
    for (const path of report.changedFiles) copyFileSync(safePath(candidateRoot, path), safePath(repo, path));
    report.applied = true;
  }
  return report;
  } catch (error) {
    error.report = { ...report, status: 'error', result_changed: false, changedFiles: [], applied: false, error: error.message };
    throw error;
  }
}
if (import.meta.main) {
  const args = process.argv.slice(2), mode = args.shift();
  const options = { mode };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--apply') options.apply = true;
    else if (['--repo', '--temp-root', '--output'].includes(flag) && args[index + 1]) options[flag === '--temp-root' ? 'tempRoot' : flag.slice(2)] = args[++index];
    else throw new Error(`不明な引数: ${flag}`);
  }
  let report;
  try { report = await maintain(options); }
  catch (error) { report = error.report ?? { schemaVersion: 1, status: 'error', result_changed: false, changedFiles: [], error: error.message }; }
  const text = JSON.stringify(report, null, 2) + '\n';
  if (options.output) writeFileSync(safePath(dirname(resolve(options.output)), resolve(options.output)), text);
  console.log(text);
  process.exitCode = report.status === 'error' ? 1 : report.remaining?.length ? 2 : 0;
}
