// chrome-profile-seed.mjs — Chrome を起動するスクリプトが必ず使う、Windows アカウントのロック防止ヘルパー（必須）。
//
// 実害（2026-11-15）: Puppeteer で Chrome を並列起動した結果、Windows アカウントがロックされた。
// 原因: Chromium は Windows で「OS ユーザーのパスワードが空か」を確かめるため、パスワード空で
// LogonUser を呼ぶ（chrome/browser/password_manager/password_manager_util_win.cc の
// CheckBlankPasswordWithPrefs）。空でないアカウントでは毎回「ログオン失敗」(Security 4625) になり、
// 結果は Local State の password_manager.os_password_last_changed / os_password_blank に保存される。
// 新しいプロファイルを作るたびにこの確認が走るため、並列・連続で起動すると失敗回数がロックアウトの
// しきい値を超える。
//
// 対策: 起動前に user-data-dir の Local State へ「確認済み・空パスワードではない」を書いておく。
// need_recheck は `pref_last_changed > 0 && last_changed <= pref_last_changed` で false になるので、
// os_password_last_changed に int64 上限近い値（Chromium の int64 pref は文字列で保存）を入れれば、
// パスワードを変更しても再確認されず LogonUser は呼ばれない。あわせてパスワードマネージャー自体も無効にする。
// 既存の Local State / Preferences がある場合は中身を保ったまま必要なキーだけ上書きする。
//
// 参考実装: Kagayoi.Support の clients/chrome-extension/store-assets/lib/capture.mjs（seedChromeProfile）と内容は同等。
// 使い方: userDataDir 未指定の puppeteer.launch は一時プロファイルを作って毎回この確認が走るので、
// createSeededProfile() で作ったディレクトリを userDataDir に渡し、終了後 removeSeededProfile() で片付ける。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** user-data-dir を作り、Local State / Default/Preferences にシードを書く。 */
export function seedChromeProfile(userDataDir) {
  fs.mkdirSync(path.join(userDataDir, "Default"), { recursive: true });
  const merge = (file, patch) => {
    let json = {};
    try { json = JSON.parse(fs.readFileSync(file, "utf8")); } catch { json = {}; }
    for (const [key, values] of Object.entries(patch)) {
      // オブジェクトのキーは既存値へ浅くマージし、スカラーはそのまま上書きする
      json[key] = values && typeof values === "object"
        ? { ...(json[key] && typeof json[key] === "object" ? json[key] : {}), ...values }
        : values;
    }
    fs.writeFileSync(file, JSON.stringify(json));
  };
  merge(path.join(userDataDir, "Local State"), {
    password_manager: { os_password_blank: false, os_password_last_changed: "9223372036854775000" },
  });
  merge(path.join(userDataDir, "Default", "Preferences"), {
    profile: { password_manager_enabled: false },
    credentials_enable_service: false, // トップレベルのキー
  });
}

/** 一時プロファイルの置き場。全 OS で os.tmpdir()（Windows は %TEMP%）に統一する。固定パスは持たない。 */
export function tempProfileRoot() {
  return os.tmpdir();
}

/** 一時ディレクトリを作ってシードし、userDataDir に渡せる絶対パスを返す。 */
export function createSeededProfile(prefix = "chrome-profile") {
  const dir = fs.mkdtempSync(path.join(tempProfileRoot(), `${prefix}-`));
  seedChromeProfile(dir);
  return dir;
}

/** createSeededProfile で作ったディレクトリだけを片付ける（置き場直下以外は触らない）。 */
export function removeSeededProfile(dir) {
  if (!dir || !path.isAbsolute(dir)) return;
  if (path.dirname(path.resolve(dir)) !== path.resolve(tempProfileRoot())) return;
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 片付け失敗は無視（次回の実行に影響しない） */ }
}
