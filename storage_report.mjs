// 閲覧ページの保存の診断（VIEWER_DAY_STORE.md の次の手順①「読取専用の保存診断」、2026-10-31）。
// iPhoneのSafariにどれだけ保存しているかと、読み込みが最後まで終わったか（落ちていないか）を見る。
// 保存した内容は読み直さず変えない。本体（数十MB）や日別の本文は開かず、件数と、読み込んだときに
// 分かった大きさだけを使う。読み込みの記録は localStorage の小さな1項目（DIAG_KEY）だけに書く。

export const DIAG_KEY = 'database-viewer-diag';
const PHASES = {open: '起動時の読み込み', drive: 'Googleドライブの更新'};
// このページが使う保存先。ほかの名前（同じ配信元の共有カレンダーなど）は名前だけ数える。
const KNOWN = ['database-viewer', 'database-pscube-viewer', 'database-viewer-parts-v1', 'database-viewer-days-v1'];

function readLog(storage) {
  try {
    const log = JSON.parse(storage?.getItem(DIAG_KEY) || 'null');
    if (log && log.version === 1 && log.phases && typeof log.phases === 'object') return log;
  } catch { /* 壊れた記録は数え直す */ }
  return {version: 1, running: null, phases: {}};
}

function writeLog(storage, log) {
  try { storage?.setItem(DIAG_KEY, JSON.stringify(log)); } catch { /* 書けなくても画面は止めない */ }
}

function phaseOf(log, phase) {
  return log.phases[phase] ??= {count: 0, unfinished: 0, last_ms: null, max_ms: null, last_at: null, last_unfinished_at: null};
}

/** 重い読み込みの前に呼ぶ。前の読み込みが終わっていなければ（ページが落ちた・閉じた）、それを数えてから始める。 */
export function phaseStarted(phase, {storage = globalThis.localStorage, now = () => new Date()} = {}) {
  if (!Object.hasOwn(PHASES, phase)) return;
  const log = readLog(storage);
  if (log.running && Object.hasOwn(PHASES, log.running.phase)) {
    const left = phaseOf(log, log.running.phase);
    left.unfinished++;
    left.last_unfinished_at = log.running.at;
  }
  log.running = {phase, at: now().toISOString()};
  writeLog(storage, log);
}

/** 読み込みが終わったら（成功・失敗どちらでも）呼ぶ。始めていない区切りは数えない。 */
export function phaseFinished(phase, {storage = globalThis.localStorage, now = () => new Date()} = {}) {
  const log = readLog(storage);
  if (log.running?.phase !== phase) return;
  const end = now(), ms = Math.max(0, end - Date.parse(log.running.at));
  const p = phaseOf(log, phase);
  p.count++;
  p.last_ms = Number.isFinite(ms) ? ms : null;
  p.max_ms = p.last_ms == null ? p.max_ms : Math.max(p.max_ms ?? 0, p.last_ms);
  p.last_at = end.toISOString();
  log.running = null;
  writeLog(storage, log);
}

// 既にある保存先だけを、版を指定せずに開く（無い保存先を開くと空のまま作られ、ページが正しく作り直せなくなる）。
function openExisting(idb, name) {
  return new Promise((resolve, reject) => {
    const request = idb.open(name);
    request.onupgradeneeded = () => request.transaction.abort();  // 一覧のあとに消えていたら作らない
    request.onerror = () => reject(request.error || new Error('open'));
    request.onblocked = () => reject(new Error('blocked'));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();  // ページ本体の版上げを待たせない
      resolve(db);
    };
  });
}

function ask(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function inspectDatabase(idb, name) {
  const db = await openExisting(idb, name);
  try {
    const result = {stores: {}};
    for (const store of [...db.objectStoreNames]) {
      // 要求は同じトランザクションで先にすべて出してから待つ（待つ間に古いSafariでトランザクションが閉じないように）。
      const tx = db.transaction(store, 'readonly'), objects = tx.objectStore(store);
      const kv = name === 'database-viewer' && store === 'kv';
      // 🌈の印は本体と別の小さな文字列（RAINBOW.md）。本体 'data' は開かない。
      const [total, keys, marks] = await Promise.all([ask(objects.count()),
        kv ? ask(objects.getAllKeys()) : null, kv ? ask(objects.get('rainbow_marks')) : null]);
      result.stores[store] = total;
      if (kv) {
        result.keys = keys.map(String).sort();
        if (typeof marks === 'string') {
          result.marks_chars = marks.length;
          try { const list = JSON.parse(marks); result.marks = Array.isArray(list) ? list.length : null; } catch { result.marks = null; }
        }
      }
    }
    return result;
  } finally { db.close(); }
}

/** 保存の状態を集める。[loaded] はこのページが本体を読み込んだ・保存したときに分かった文字数。 */
export async function collectStorageReport({idb = globalThis.indexedDB, nav = globalThis.navigator,
  storage = globalThis.localStorage, loaded = null} = {}) {
  const report = {estimate: null, persisted: null, databases: null, others: null, inspected: {}, failed: [], loaded, log: readLog(storage), local_chars: null};
  try {
    if (nav?.storage?.estimate) {
      const e = await nav.storage.estimate();
      report.estimate = {usage: Number.isFinite(e?.usage) ? e.usage : null, quota: Number.isFinite(e?.quota) ? e.quota : null};
    }
  } catch { report.failed.push('estimate'); }
  try { if (nav?.storage?.persisted) report.persisted = await nav.storage.persisted(); } catch { report.failed.push('persisted'); }
  let names = null;
  try { if (idb?.databases) names = (await idb.databases()).map(d => d.name).filter(n => typeof n === 'string'); } catch { report.failed.push('databases'); }
  if (names) {
    report.databases = KNOWN.filter(n => names.includes(n));
    report.others = names.filter(n => !KNOWN.includes(n)).sort();
    for (const name of report.databases) {
      try { report.inspected[name] = await inspectDatabase(idb, name); } catch { report.failed.push(name); }
    }
  }
  try {
    let chars = 0;
    for (let i = 0; i < storage.length; i++) { const k = storage.key(i); chars += k.length + (storage.getItem(k) || '').length; }
    report.local_chars = chars;
  } catch { report.failed.push('localStorage'); }
  return report;
}

const mb = n => `約${(n / 1048576).toLocaleString('ja-JP', {minimumFractionDigits: 1, maximumFractionDigits: 1})}MB`;
const count = n => Number(n).toLocaleString('ja-JP');
const seconds = ms => `${(ms / 1000).toLocaleString('ja-JP', {maximumFractionDigits: 1})}秒`;
const when = s => Number.isFinite(Date.parse(s)) ? new Date(s).toLocaleString('ja-JP') : '不明';

/** 画面（「更新・差枚の取得状況」）に出す行。 */
export function storageReportLines(report) {
  const lines = ['この端末の保存（診断）：保存した内容は読み直さず、変えていません。'];
  const e = report.estimate;
  lines.push(e?.usage != null
    ? `保存領域：${mb(e.usage)}を使用${e.quota != null ? `／上限の目安 ${mb(e.quota)}` : ''}（同じ配信元の共有カレンダーを含む、ブラウザが示す目安）`
    : '保存領域の使用量：このブラウザでは確認できません');
  if (report.persisted != null) lines.push(`保存の保護（自動で消されにくい設定）：${report.persisted ? 'あり' : 'なし'}`);
  const l = report.loaded;
  lines.push(l?.chars != null
    ? `本体（前に読み込んだ内容${l.source === 'pscube' ? '・P’s CUBE' : ''}）：${mb(l.chars)}（${count(l.chars)}文字、このページで読み込んだときの大きさ）`
    : '本体の大きさ：このページではまだ読み込んでいません');
  if (!report.databases) {
    lines.push('保存先の一覧：このブラウザでは確認できません（開くと空の保存先を作ってしまうため、開いていません）');
  } else {
    const at = name => report.inspected[name];
    const viewer = at('database-viewer');
    if (viewer) {
      lines.push(`本体の保存先：${viewer.keys?.includes('data') ? 'メルヘンの本体あり' : 'メルヘンの本体なし'}`
        + `${viewer.marks != null ? `・🌈の印（本体と別）${count(viewer.marks)}件（${count(viewer.marks_chars)}文字）` : '・本体と別の🌈の印なし'}`);
    } else lines.push(report.failed.includes('database-viewer') ? '本体の保存先：確認できませんでした' : '本体の保存先：まだありません');
    const pscube = at('database-pscube-viewer');
    if (pscube) lines.push(`P’s CUBEの保存先：${count(Object.values(pscube.stores).reduce((a, b) => a + b, 0))}項目`);
    const parts = at('database-viewer-parts-v1');
    lines.push(parts
      ? `日別キャッシュ（Googleの部品）：${count(parts.stores['history-days'] ?? 0)}日分（接続先${count(parts.stores['history-heads'] ?? 0)}件・旧形式${count(parts.stores.snapshots ?? 0)}件）`
      : `日別キャッシュ（Googleの部品）：${report.failed.includes('database-viewer-parts-v1') ? '確認できませんでした' : 'なし'}`);
    const days = at('database-viewer-days-v1');
    lines.push(days
      ? `新しい日別保存：索引${count(days.stores.heads ?? 0)}件・本文${count(days.stores.bodies ?? 0)}件`
      : `新しい日別保存：${report.failed.includes('database-viewer-days-v1') ? '確認できませんでした' : 'まだ使っていません'}`);
    if (report.others.length) lines.push(`同じ配信元のほかの保存先：${report.others.join('・')}`);
  }
  if (report.local_chars != null) lines.push(`小さな設定の保存（localStorage）：${count(report.local_chars)}文字`);
  for (const [phase, label] of Object.entries(PHASES)) {
    const p = report.log.phases[phase];
    if (!p) { lines.push(`${label}：まだ記録がありません`); continue; }
    lines.push(`${label}：最後まで終わった${count(p.count)}回`
      + `${p.last_ms != null ? `・前回${seconds(p.last_ms)}` : ''}${p.max_ms != null ? `・最長${seconds(p.max_ms)}` : ''}`
      + `・途中で終わった${count(p.unfinished)}回${p.unfinished ? `（最後：${when(p.last_unfinished_at)}に始めた分）` : ''}`);
  }
  if (report.log.running && Object.hasOwn(PHASES, report.log.running.phase)) {
    lines.push(`いま${PHASES[report.log.running.phase]}の途中です（${when(report.log.running.at)}から）`);
  }
  lines.push('「途中で終わった」は、読み込みの途中でページが終わったこと（Safariが落ちた・ページを閉じた・Safariが裏のページを片付けた）を、次に開いたときに数えたものです。時間は裏に回っていた間も含みます。メモリの使用量はSafariでは測れません。');
  return lines;
}
