// bun run deps から起動する。[run] bun=true が依存のlifecycleにもBunを渡す。
import { lstatSync } from 'node:fs';
const manifest = await Bun.file('package.json').json();
if (manifest.packageManager !== `bun@${Bun.version}`) {
  throw new Error(`packageManagerに固定したBunを使ってください: ${manifest.packageManager}`);
}
const file = Bun.file('bun.lock');
if (!(await file.exists())) throw new Error('bun.lock がありません。固定依存の復元を中止しました。');
if (!lstatSync('bun.lock').isFile()) throw new Error('bun.lock は通常ファイルである必要があります。');
const lock = Bun.JSON5.parse(await file.text());
if (!lock || ![1, 2, 3].includes(lock.lockfileVersion) ||
    !lock.workspaces || !Object.hasOwn(lock.workspaces, '') ||
    !lock.packages || Array.isArray(lock.packages) || typeof lock.packages !== 'object') {
  throw new Error('bun.lock が不正です。固定依存の復元を中止しました。');
}
const result = Bun.spawnSync({
  cmd: [process.execPath, 'install', '--frozen-lockfile', ...process.argv.slice(2)],
  stdio: ['inherit', 'inherit', 'inherit'],
});
if (result.error) throw result.error;
process.exit(result.exitCode);
