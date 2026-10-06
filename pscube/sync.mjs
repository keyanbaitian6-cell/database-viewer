// P’s CUBE のバックアップ書き出しとGoogleドライブの自動読み込み（仕様：database/PSCUBE_SYNC.md）。
// ドライブの読み込みは、メルヘンの閲覧ページと同じGoogle Apps ScriptのURLに ?file=pscube を付けて使う。
import { validateData, recordKey } from './data.mjs';
import { DRIVE_RETRY_DELAYS_MS, HEDGE_AFTER_MS, checkVersion, hedgedFetch, isUnchanged, versionStore } from '../drive_fetch.mjs';

export const REMOTE_KEY = 'database-viewer-remote';   // メルヘンの閲覧ページと同じ（同じブラウザで共有）
const SCRIPT_URL = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;
export const DRIVE_TIMEOUT_MS = 60000;
// Apps Scriptの中継先は、ときどき返事が固まり、30〜90秒たってから404を返す（2026-10-04の実測）。
// 待ち続けても戻らないので、8秒返事がなければ同じリクエストをもう1本出し、先に成功した方を使う。
// 404・429・5xx・通信失敗は、少し待って次を出す（最初の1本と合わせて最大4本）。部品は ../drive_fetch.mjs。
export { DRIVE_RETRY_DELAYS_MS };

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
    ...(valid.date_events ? {date_events:valid.date_events} : {}),
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
 *
 * 先に ?check=1 で「更新の目印」だけを確かめる（新しいApps Scriptのとき数行の返事）。表示中の内容
 * （[known]）を前に読んだときと目印が同じなら、ファイルを読まずに終わる。目印は読む前に確かめるので、
 * 読んでいる間にファイルが更新されても、次に開いたときは読み直す。
 * 古いスクリプトは全文を返すので、その全文をそのまま使う（今までどおり）。
 */
export async function fetchDrive(base, known, {
  fetchImpl = fetch, timeoutMs = DRIVE_TIMEOUT_MS, retryDelays = DRIVE_RETRY_DELAYS_MS, hedgeMs = HEDGE_AFTER_MS,
  versions = versionStore('pscube'),
} = {}) {
  const url = driveUrl(base), controller = new AbortController();
  let timer = 0;
  // 画面を離れている間（iPhoneでほかのアプリに切り替えた等）は時間を数えない。戻ったら数え直す。
  // リクエストを出すたびに、無応答の時間を数え直す。
  const page = globalThis.document ?? null;
  const wait = () => { clearTimeout(timer); if (page?.visibilityState !== 'hidden') timer = setTimeout(() => controller.abort(), timeoutMs); };
  const onVisibility = () => wait();
  page?.addEventListener?.('visibilitychange', onVisibility);
  wait();
  const options = { fetchImpl, signal: controller.signal, hedgeMs, retryDelays, onLaunch: wait };
  const timedOut = () => new Error('Googleドライブの応答がありません（時間切れ）。');
  const explain = error => {
    if (error?.name === 'AbortError' || controller.signal.aborted) return timedOut();
    if (error?.status) return new Error(`Googleドライブから読めませんでした（${error.status}）。`);
    return new Error('Googleドライブに接続できません。');
  };
  try {
    let text, version = null;
    try {
      const checked = await checkVersion(`${url}&check=1`, options);
      version = checked.version ?? null;
      if (isUnchanged(versions.get(), version, known)) return { unchanged: true, exportedAt: known };
      // 古いスクリプトが全文を返したときは、それをそのまま使う。
      if (checked.stream) text = await new Response(checked.stream).text();
      else if (checked.response && !checked.response.ok) throw Object.assign(new Error('http'), { status: checked.response.status });
      if (text === undefined) {
        const response = await hedgedFetch(url, options);
        if (!response.ok) throw Object.assign(new Error('http'), { status: response.status });
        text = await response.text();
      }
    } catch (error) { throw explain(error); }
    let doc;
    try { doc = JSON.parse(text); } catch { throw new Error('Googleドライブの内容を読めません。'); }
    if (doc?.error) throw new Error(String(doc.error).slice(0, 200));
    if (doc?.format !== 'pscube-viewer') {
      throw new Error('P’s CUBEのファイルではありません。Apps Scriptを更新してください（database/PSCUBE_SYNC.md）。');
    }
    const exportedAt = typeof doc.exported_at === 'string' ? doc.exported_at : null;
    // 目印は、全文を読み終えて中身が正しいと分かってから覚える。
    if (version) versions.set({ version, exported_at: exportedAt });
    if (known && exportedAt === known) return { unchanged: true, exportedAt };
    return { unchanged: false, exportedAt, data: validateData(doc) };
  } finally { clearTimeout(timer); page?.removeEventListener?.('visibilitychange', onVisibility); }
}
