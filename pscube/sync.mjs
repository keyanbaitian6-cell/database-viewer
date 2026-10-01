// P’s CUBE のバックアップ書き出しとGoogleドライブの自動読み込み（仕様：database/PSCUBE_SYNC.md）。
// ドライブの読み込みは、メルヘンの閲覧ページと同じGoogle Apps ScriptのURLに ?file=pscube を付けて使う。
import { validateData, recordKey } from './data.mjs';

export const REMOTE_KEY = 'database-viewer-remote';   // メルヘンの閲覧ページと同じ（同じブラウザで共有）
const SCRIPT_URL = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;
export const DRIVE_TIMEOUT_MS = 60000;

const two = v => String(v).padStart(2, '0');

/** 共有フォルダに置くバックアップの名前。メルヘンの database-backup-* と重ならない。 */
export function backupFileName(now = new Date()) {
  return `pscube-backup-browser-${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}` +
    `-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}.json`;
}

/** 時差つきの時刻（例 2026-10-01T09:05:07+09:00）。 */
export function timestampWithOffset(now = new Date()) {
  const offset = -now.getTimezoneOffset(), sign = offset >= 0 ? '+' : '-', abs = Math.abs(offset);
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}T${two(now.getHours())}:` +
    `${two(now.getMinutes())}:${two(now.getSeconds())}${sign}${two(Math.floor(abs / 60))}:${two(abs % 60)}`;
}

/**
 * 閲覧ページに入っている内容を、PC・Androidが読み込めるバックアップにする。ブラウザには
 * 取り込み済みの印が無いので、台別7日分のグラフがある日を取り込み済みとして出す。
 */
export function buildBackup(data, now = new Date()) {
  const valid = validateData(data);
  return { format: valid.format, version: 1, kind: 'backup', source: 'browser', exported_at: timestampWithOffset(now),
    machines: valid.machines, records: valid.records,
    rack_captures: valid.records.filter(r => r.graph?.kind === 'daily').map(recordKey) };
}

/** 保存したApps ScriptのURLに ?file=pscube を付ける。形が違えば例外。 */
export function driveUrl(base) {
  if (!SCRIPT_URL.test(base || '')) {
    throw new Error('GoogleのスクリプトのURL（https://script.google.com/macros/s/…/exec）を入れてください。');
  }
  return `${base}?file=pscube`;
}

/**
 * Googleドライブの最新を読む。書き出した時刻が [known] と同じなら中身を使わず {unchanged: true}。
 * ファイルが違う（更新前のスクリプトがメルヘンの閲覧用ファイルを返した等）・読めないときは例外で、
 * 呼び出し側は何も変えない。
 */
export async function fetchDrive(base, known, { fetchImpl = fetch, timeoutMs = DRIVE_TIMEOUT_MS } = {}) {
  const url = driveUrl(base), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try { response = await fetchImpl(url, { cache: 'no-store', signal: controller.signal, redirect: 'follow' }); }
    catch (e) { throw new Error(e?.name === 'AbortError' ? 'Googleドライブの応答がありません（時間切れ）。' : 'Googleドライブに接続できません。'); }
    if (!response.ok) throw new Error(`Googleドライブから読めませんでした（${response.status}）。`);
    let doc;
    try { doc = JSON.parse(await response.text()); } catch { throw new Error('Googleドライブの内容を読めません。'); }
    if (doc?.error) throw new Error(String(doc.error).slice(0, 200));
    if (doc?.format !== 'pscube-viewer') {
      throw new Error('P’s CUBEのファイルではありません。Apps Scriptを更新してください（database/PSCUBE_SYNC.md）。');
    }
    const exportedAt = typeof doc.exported_at === 'string' ? doc.exported_at : null;
    if (known && exportedAt === known) return { unchanged: true, exportedAt };
    return { unchanged: false, exportedAt, data: validateData(doc) };
  } finally { clearTimeout(timer); }
}
