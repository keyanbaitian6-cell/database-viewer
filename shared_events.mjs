// 共有カレンダー（EVENT_CALENDAR.md、2026-10-08）：Apps Script（tool/viewer_drive_script.gs）の共有ファイルを
// 読む・イベントを送る。メルヘンの閲覧ページ（index.html）とP’s CUBEのページ（pscube/viewer_bridge.mjs）で共通。
import { hedgedFetch } from './drive_fetch.mjs';

const SCRIPT_URL = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;
export const SHARED_FILES = ['events', 'pscube-events'];
const POST_TIMEOUT_MS = 30000;

/** 共有ファイル（[file] は events・pscube-events）を読み、返事の文字をそのまま返す。 */
export async function fetchShared(url, file, fetchImpl = (...args) => fetch(...args)) {
  if (!SCRIPT_URL.test(url || '') || !SHARED_FILES.includes(file)) {
    throw new Error('共有カレンダーの読み込み先が不正です。');
  }
  const response = await hedgedFetch(url + '?file=' + file, { fetchImpl });
  if (!response.ok) throw new Error('共有カレンダーを読めませんでした（' + response.status + '）。');
  return await response.text();
}

/** イベントをスクリプトへ送る（text/plain で送るので事前確認の通信は出ない）。返事の文字を返す。 */
export async function postShared(url, text, fetchImpl = (...args) => fetch(...args)) {
  if (!SCRIPT_URL.test(url || '')) throw new Error('共有カレンダーの送り先が不正です。');
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), POST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: text, signal: abort.signal,
    });
    if (!response.ok) throw new Error('共有カレンダーに送れませんでした（' + response.status + '）。');
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}
