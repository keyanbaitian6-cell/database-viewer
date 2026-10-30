// 生成元: tool/build_viewer_parts.mjs
const SCRIPT_RELEASE = 'cc5e38dc99b9';
// 日別の不変ファイルと、最後に確定する一覧。Google・ブラウザで同じ検査を使う。
const VP_FORMAT = 'database-viewer-parts';
const VP_MAX_BYTES = 48 * 1024 * 1024;
const VP_PART_BYTES = 1024 * 1024;
const VP_BATCH = 8;
function vpCanonical(value) {
  if (Array.isArray(value)) return '[' + value.map(vpCanonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + vpCanonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function vpManifestName(site) { return 'database-viewer-parts-' + site + '.json'; }
function vpPartName(site, hash) { return 'database-viewer-part-' + site + '-' + hash + '.json'; }
function vpValidManifest(m, site) {
  const fail = () => { throw new Error('閲覧用の更新一覧が不正です。'); };
  if (!m || m.format !== VP_FORMAT || ![1, 2].includes(m.version) || m.site !== site ||
      !['meruhen', 'pscube'].includes(site) || !/^[a-f0-9]{64}$/.test(m.revision) ||
      !m.header || typeof m.header !== 'object' || Array.isArray(m.header) || 'records' in m.header ||
      m.header.version !== 1 || m.header.format !== (site === 'meruhen' ? 'database-backup' : 'pscube-viewer') ||
      typeof m.header.exported_at !== 'string' || !Array.isArray(m.parts) || m.parts.length > (m.version === 2 ? 16384 : 1024)) fail();
  const seen = new Set(), days = new Map(); let bytes = 0, count = 0;
  for (const p of m.parts) {
    if (!p || !/^[a-f0-9]{64}$/.test(p.hash) || seen.has(p.hash) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(p.day) || !Number.isSafeInteger(p.count) || p.count < 1 ||
        !Number.isSafeInteger(p.bytes) || p.bytes < 2 || p.bytes > VP_PART_BYTES) fail();
    seen.add(p.hash); bytes += p.bytes; count += p.count;
    const d = days.get(p.day) || {bytes: 0, count: 0}; d.bytes += p.bytes; d.count += p.count; days.set(p.day, d);
  }
  if (count !== m.count || !Number.isSafeInteger(count)) fail();
  if (m.version === 1 && (bytes > VP_MAX_BYTES || count > 100000)) fail();
  if (m.version === 2 && (!Array.isArray(m.days) || new Set(m.days).size !== m.days.length ||
      m.days.some(day => !/^\d{4}-\d{2}-\d{2}$/.test(day)) ||
      [...days].some(([day, d]) => !m.days.includes(day) || d.bytes > VP_MAX_BYTES || d.count > 100000))) fail();
  if (m.curve_parts !== undefined) {
    if (m.version !== 2 || !Array.isArray(m.curve_parts) || m.curve_parts.length > 16384) fail();
    const curves = new Set();
    for (const c of m.curve_parts) {
      if (!c || !/^[a-f0-9]{64}$/.test(c.hash) || curves.has(c.hash) || !/^\d{4}-\d{2}-\d{2}$/.test(c.day) ||
          !m.days.includes(c.day) || !Number.isSafeInteger(c.count) || c.count < 1 ||
          !Number.isSafeInteger(c.bytes) || c.bytes < 2 || c.bytes > VP_PART_BYTES) fail();
      curves.add(c.hash);
    }
  }
  return m;
}
function vpPublicCurves(m) {
  return m.curve_parts ? {curve_parts: m.curve_parts.map(({hash, day, count, bytes}) => ({hash, day, count, bytes}))} : {};
}
function vpPublic(m) {
  return {format: m.format, version: m.version, site: m.site, revision: m.revision,
    header: m.header, count: m.count, ...(m.version === 2 ? {days: m.days, history: true} : {}),
    parts: m.parts.map(({hash, day, count, bytes}) => ({hash, day, count, bytes})), ...vpPublicCurves(m)};
}
// メルヘンのグラフの線は、閲覧用の記録から外して日ごとの線パーツに置く（2026-10-25、iPhoneのメモリ）。
// 記録の graph_measurement.curve_index（その日の中の通し番号）と、線パーツの [番号, 線] を結ぶ。
// 中身に日付を含め、別の日と同じ内容（同じハッシュ）にならないようにする。
const VP_CURVES_FORMAT = 'database-viewer-curves';
function vpCurveName(site, hash) { return 'database-viewer-curves-' + site + '-' + hash + '.json'; }
function vpCurveRows(text, ref) {
  const doc = JSON.parse(text), rows = doc && doc.curves;
  if (!doc || doc.day !== ref.day || !Array.isArray(rows) || rows.length !== ref.count ||
      rows.some(r => !Array.isArray(r) || r.length !== 2 || !Number.isSafeInteger(r[0]) || r[0] < 0 || !Array.isArray(r[1]))) {
    throw new Error('グラフの線のデータが更新一覧と一致しません。');
  }
  return rows;
}
function vpRows(text, part) {
  const rows = JSON.parse(text);
  if (!Array.isArray(rows) || rows.length !== part.count || rows.some(r => !r || r.day !== part.day)) {
    throw new Error('閲覧用の日別データが更新一覧と一致しません。');
  }
  return rows;
}

// v1のsnapshotsを保持したまま、日別の履歴へ移行する。取得・検査が完了してから確定する。
function vpCache() {
  // Reopening a long history must not retain every JSON string alongside the
  // decoded records. Read one day per transaction; never hold a transaction
  // open while awaiting crypto or rendering work.
  async function* stream(key) {
    if (!globalThis.indexedDB) return;
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('database-viewer-parts-v1', 2);
      request.onupgradeneeded = () => {
        for (const name of ['snapshots', 'history-heads', 'history-days']) {
          if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
        }
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('cache blocked'));
      request.onsuccess = () => resolve(request.result);
    });
    const read = (store, id) => new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly'), request = tx.objectStore(store).get(id);
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
    try {
      const head = await read('history-heads', key);
      if (!head) return;
      yield {header: head.header, days: head.days};
      for (const day of head.days) {
        // Verify the head did not change during a concurrent tab's commit.
        // The final check also detects a writer that replaced an earlier day.
        const value = await read('history-days', key + '|' + day);
        if (!value) throw new Error('保存した履歴の一部がありません。オンラインで最新を読み込んでください。');
        if (!value.parts || typeof value.parts !== 'object' || Array.isArray(value.parts)) throw new Error('保存した履歴が破損しています。');
        yield {day, parts: value.parts};
      }
      const latest = await read('history-heads', key);
      if (vpCanonical(latest) !== vpCanonical(head)) throw new Error('履歴が更新されました。もう一度読み込んでください。');
    } finally { db.close(); }
  }
  async function run(key, value, writing) {
    if (!globalThis.indexedDB) {
      if (writing) throw new Error('端末の保存領域を利用できません。');
      return null;
    }
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('database-viewer-parts-v1', 2);
      request.onupgradeneeded = () => {
        for (const name of ['snapshots', 'history-heads', 'history-days']) {
          if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
        }
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('cache blocked'));
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction(['snapshots', 'history-heads', 'history-days'], writing ? 'readwrite' : 'readonly');
        const heads = tx.objectStore('history-heads'), days = tx.objectStore('history-days');
        const head = heads.get(key);
        const result = {parts: {}, header: null, days: [], missingDays: [], partDays: {}};
        let stale = false;
        head.onsuccess = () => {
          if (writing) {
            const current = head.result || {days: []};
            // 古い通信が後から完了しても、新しく確定した日のデータを巻き戻さない。比べるのはGoogleの日別一覧どうしの時刻
            // （parts_at）だけ。閲覧用ファイル全体を読んだときの時刻（PCの書き出し）は一覧と別の時計なので比べない
            // （2026-10-18：全体を読んだ後、一覧の時刻が古いまま進まず、P-STATIONの保存を毎回断っていた）。
            if (value.header?.parts_at && Date.parse(current.header?.parts_at) > Date.parse(value.header.parts_at)) { stale = true; return; }
            for (const [day, parts] of Object.entries(value.updates)) days.put({parts}, key + '|' + day);
            heads.put({header: value.header, days: [...new Set([...current.days, ...Object.keys(value.updates)])].sort(), revision: (current.revision || 0) + 1}, key);
          } else if (head.result) {
            result.header = head.result.header; result.days = head.result.days;
            for (const day of head.result.days) {
              const part = days.get(key + '|' + day);
              part.onsuccess = () => {
                if (!part.result) { result.missingDays.push(day); return; }
                Object.assign(result.parts, part.result.parts || {});
                for (const hash of Object.keys(part.result.parts || {})) result.partDays[hash] = day;
              };
            }
          } else {
            const legacy = tx.objectStore('snapshots').get(key);
            legacy.onsuccess = () => Object.assign(result.parts, legacy.result?.parts || {});
          }
        };
        tx.oncomplete = () => { db.close(); resolve(writing ? {stale} : result); };
        tx.onabort = tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  }
  return {get: key => run(key), commit: (key, value) => run(key, value, true), stream};
}
function vpEndpointKey(url, site) { const endpoint = new URL(url); endpoint.search = ''; endpoint.hash = ''; return endpoint.href + '|' + site; }
function vpCachedDays(cached) {
  const days = new Map();
  for (const [hash, text] of Object.entries(cached?.parts || {})) {
    const indexedDay = cached?.partDays?.[hash];
    if (typeof indexedDay === 'string') {
      if (!days.has(indexedDay)) days.set(indexedDay, {});
      days.get(indexedDay)[hash] = text; continue;
    }
    let rows;
    try { rows = JSON.parse(text); } catch { continue; }
    const day = rows?.[0]?.day;
    if (!Array.isArray(rows) || typeof day !== 'string' || rows.some(r => r?.day !== day)) continue;
    if (!days.has(day)) days.set(day, {}); days.get(day)[hash] = text;
  }
  return days;
}
async function vpStoreHistory(cache, key, cached, updates, header) {
  if (cache.commit) {
    // v1キャッシュの全日を最初のトランザクションに含め、移行漏れを防ぐ。
    const migration = cached?.header ? {} : Object.fromEntries(vpCachedDays(cached));
    const result = await cache.commit(key, {updates: {...migration, ...updates}, header});
    if (result?.stale) throw new Error('ほかの更新で新しい履歴が保存されています。もう一度読み込んでください。');
  } else {
    const days = vpCachedDays(cached);
    for (const [day, parts] of Object.entries(updates)) days.set(day, parts);
    await cache.set(key, {header, parts: Object.assign({}, ...days.values())});
  }
}
// 既存の自分用ページに保存済みの全期間データを、接続先ごとの履歴へ引き継ぐ。
async function rememberViewerHistory(url, site, doc, cache = vpCache(), replaceDays = false) {
  if (!doc || !Array.isArray(doc.records)) return;
  const key = vpEndpointKey(url, site), cached = await cache.get(key), days = vpCachedDays(cached), updates = {};
  for (const row of doc.records) {
    if (typeof row?.day !== 'string') continue;
    if (!updates[row.day]) updates[row.day] = [];
    updates[row.day].push(row);
  }
  for (const [day, rows] of Object.entries(updates)) {
    if (!replaceDays && days.has(day)) { delete updates[day]; continue; } // 移行時にGoogleで確定済みの日は変更しない。
    const text = JSON.stringify(rows), hash = await vpClientHash(text); updates[day] = {[hash]: text};
  }
  if (!Object.keys(updates).length && cached?.header) return;
  const {records, ...header} = doc;
  await vpStoreHistory(cache, key, cached, updates, replaceDays ? header : cached?.header || header);
}
async function vpClientHash(text) {
  const data = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(data)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function readViewerHistory(url, site, cache = vpCache()) {
  if (cache.stream) {
    let header = null, days = [], records = [];
    for await (const value of cache.stream(vpEndpointKey(url, site))) {
      if (value.header) { header = value.header; days = value.days; continue; }
      for (const [hash, text] of Object.entries(value.parts || {})) {
        if (await vpClientHash(text) !== hash) throw new Error('保存した履歴が破損しています。オンラインで最新を読み込んでください。');
        const rows = JSON.parse(text);
        if (!Array.isArray(rows) || rows.some(r => r?.day !== value.day)) throw new Error('保存した履歴の日付が一致しません。');
        for (const row of rows) records.push(row);
      }
    }
    if (!header) return null;
    return {...header, history: true, history_days: days, records};
  }
  const cached = await cache.get(vpEndpointKey(url, site));
  if (!cached?.header) return null;
  if (cached.missingDays?.length) throw new Error('保存した履歴の一部がありません。オンラインで最新を読み込んでください。');
  const records = [];
  for (const [hash, text] of Object.entries(cached.parts)) {
    if (await vpClientHash(text) !== hash) throw new Error('保存した履歴が破損しています。オンラインで最新を読み込んでください。');
    records.push(...JSON.parse(text));
  }
  return {...cached.header, history: true, history_days: cached.days || [...vpCachedDays(cached).keys()], records};
}
async function fetchViewerParts(url, site, manifest, getJson, cache = vpCache()) {
  const m = vpValidManifest(manifest, site), endpoint = new URL(url);
  endpoint.search = ''; endpoint.hash = '';
  const key = endpoint.href + '|' + site;
  let cached = null;
  try { cached = await cache.get(key); }
  catch { throw new Error('履歴を端末から読み出せませんでした。保存データは変更していません。'); }
  const parts = new Map(), missing = [];
  for (const p of m.parts) {
    const text = cached?.parts?.[p.hash];
    // 端末内の欠損・破損も、当該パーツだけ再取得する。
    if (typeof text === 'string' && new TextEncoder().encode(text).length === p.bytes && await vpClientHash(text) === p.hash) {
      vpRows(text, p); parts.set(p.hash, text);
    } else missing.push(p);
  }
  for (let i = 0; i < missing.length; i += VP_BATCH) {
    const batch = missing.slice(i, i + VP_BATCH), request = new URL(endpoint);
    if (site === 'pscube') request.searchParams.set('file', 'pscube');
    request.searchParams.set('revision', m.revision);
    request.searchParams.set('parts', batch.map(p => p.hash).join(','));
    const result = await getJson(request.href);
    if (result?.format !== VP_FORMAT || result.revision !== m.revision || !Array.isArray(result.parts) ||
        result.parts.length !== batch.length) throw new Error('閲覧用が更新されました。もう一度読み込んでください。');
    for (let j = 0; j < batch.length; j++) {
      const p = batch[j], item = result.parts[j];
      if (item?.hash !== p.hash || typeof item.text !== 'string' || new TextEncoder().encode(item.text).length !== p.bytes ||
          await vpClientHash(item.text) !== p.hash) throw new Error('閲覧用の日別データが一致しません。');
      vpRows(item.text, p); parts.set(p.hash, item.text);
    }
  }
  const covered = m.version === 2 ? m.days : [...new Set(m.parts.map(p => p.day))];
  if (cached?.missingDays?.some(day => !covered.includes(day))) {
    throw new Error('Googleにない過去の履歴が端末で欠損しています。元バックアップから復元してください。保存データは変更していません。');
  }
  // 現行一覧にある壊れたパーツは取得済みの正しい内容へ置換してから検査する。
  const restored = {...(cached?.parts || {})};
  for (const [hash, text] of parts) restored[hash] = text;
  for (const [hash, text] of Object.entries(restored)) {
    if (await vpClientHash(text) === hash) continue;
    if (covered.includes(cached?.partDays?.[hash])) { delete restored[hash]; continue; }
    let day;
    try { day = JSON.parse(text)?.[0]?.day; } catch { /* 日付不明は自動で破棄しない */ }
    if (day && covered.includes(day)) { delete restored[hash]; continue; }
    throw new Error('保存した過去の履歴が破損しています。元バックアップから復元してください。保存データは変更していません。');
  }
  const history = vpCachedDays({parts: restored, partDays: cached?.partDays}), updates = {};
  // v1の対象範囲内で消えた日も完成版として空にする。期間外の古い日は残す。
  if (m.version === 1 && covered.length) {
    const sorted = covered.slice().sort();
    for (const day of history.keys()) if (day >= sorted[0] && day <= sorted.at(-1) && !covered.includes(day)) covered.push(day);
  }
  for (const day of covered) updates[day] = {};
  for (const p of m.parts) updates[p.day][p.hash] = parts.get(p.hash);
  for (const [day, value] of Object.entries(updates)) history.set(day, value);
  for (const [day, value] of history) {
    if (Object.hasOwn(updates, day)) continue;
    for (const [hash, text] of Object.entries(value)) if (await vpClientHash(text) !== hash) {
      throw new Error('保存した過去の履歴が破損しています。元バックアップから復元してください。保存データは変更していません。');
    }
  }
  // 日別に保存した過去分も既存画面へ渡す。画面・採点規則は変えない。
  // グラフの線の参照（台の画面を開いたときに fetchViewerCurves で読む）は、端末に保存する見出しにも残す。
  const curveRefs = vpPublicCurves(m);
  const doc = {...m.header, ...curveRefs, history: true, history_days: [...history.keys()].sort(), records: [...history].sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([day, texts]) => Object.values(texts).flatMap(text => {
      const rows = JSON.parse(text);
      if (!Array.isArray(rows) || rows.some(r => r?.day !== day)) throw new Error('保存した履歴の日付が一致しません。');
      return rows;
    }))};
  const previousDays = vpCachedDays(cached);
  const changed = Object.fromEntries(Object.entries(updates).filter(([day, value]) =>
    cached?.missingDays?.includes(day) || Object.keys(previousDays.get(day) || {}).sort().join(',') !== Object.keys(value).sort().join(',')));
  try { await vpStoreHistory(cache, key, cached, changed, {...m.header, ...curveRefs, parts_at: m.header.exported_at}); }
  catch (e) { throw new Error('履歴を端末に保存できませんでした。前の保存データは保持しています。空き容量とブラウザの保存設定を確認してください。'); }
  return doc;
}
// 1日分のグラフの線を読む（[通し番号, 線] の一覧）。refs は一覧の curve_parts のうちその日の分。
async function fetchViewerCurves(url, site, refs, getJson) {
  const endpoint = new URL(url); endpoint.search = ''; endpoint.hash = '';
  const rows = [];
  for (const ref of refs) {
    const request = new URL(endpoint);
    if (site === 'pscube') request.searchParams.set('file', 'pscube');
    request.searchParams.set('curves', ref.hash);
    const result = await getJson(request.href);
    if (result && typeof result.error === 'string') throw new Error(result.error);
    if (result?.format !== VP_CURVES_FORMAT || result.hash !== ref.hash || typeof result.text !== 'string' ||
        new TextEncoder().encode(result.text).length !== ref.bytes || await vpClientHash(result.text) !== ref.hash) {
      throw new Error('グラフの線のデータが一致しません。');
    }
    rows.push(...vpCurveRows(result.text, ref));
  }
  return rows;
}
async function fetchViewerDocument(url, site, getJson, cache) {
  const check = new URL(url); check.searchParams.set('check', '1');
  if (site === 'meruhen') check.searchParams.set('access', '1');
  // 更新途中の版変更は、一覧を取り直して1回だけ再試行する。
  for (let attempt = 0; ; attempt++) {
    const doc = await getJson(check.href);
    if (doc?.format !== 'drive-check') return doc; // 古いスクリプトが全文を返す。
    if (!doc.parts || !globalThis.crypto?.subtle) return getJson(url);
    try { return await fetchViewerParts(url, site, doc.parts, getJson, cache); }
    catch (error) { if (attempt) throw error; }
  }
}

// 段階2の保存基盤。既存画面はまだ呼ばない。本文を持たない索引と不変の本文を分離する。
const VD_DB = 'database-viewer-days-v1';
// 参照が外れた本文を消すまでの猶予。読み込みを始めた処理は開始時の索引を固定して本文を読むので、
// この時間より長く古い版を読み続けた処理だけが「missing」になる（空として成功はしない）。
const VD_GRACE_MS = 10 * 60 * 1000;
// Google由来の補助情報のうち、大きくなる印・イベント・削除情報。見出し（書き出し時刻・線の参照など、書き出しの
// たびに変わる小さいもの）と別の本文にして、中身が変わらなければ書き直さない（レビュー指摘2）。
const VD_ANNOTATIONS = 'parts:annotations';
const VD_ANNOTATION_FIELDS = ['date_events', 'rainbow_marks', 'record_deletions'];
// 索引が参照する本文（日の本文・補助情報・移行の受領）。受領が指す本文は移行の再照合に使うので回収しない。
function vdRefs(head) {
  const refs = new Set();
  for (const d of Object.values(head.days || {})) for (const s of d.shards) refs.add(s.hash);
  for (const m of Object.values(head.metadata || {})) refs.add(m.hash);
  for (const r of Object.values(head.migration?.receipts || {})) for (const s of r.shards) refs.add(s.hash);
  if (head.migration?.quarantine) refs.add(head.migration.quarantine.hash);
  return refs;
}
const vdError = (code, message) => Object.assign(new Error(message), {code});
const vdFail = message => { throw vdError('corrupt', message); };
const vdDay = day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) &&
  Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
const vdKey = row => JSON.stringify([row.store, row.day, row.machine, row.rack, row.kind_code ?? null, row.rate ?? null]);
// 時刻を比べられる数（ミリ秒×1000＋マイクロ秒）。小数秒は6桁まで比べる（Date.parse はミリ秒までで、マイクロ秒だけ
// 古い削除時刻・印が新しい方を上書きした、2026-10-29 レビュー指摘4）。Safari に4桁以上の小数秒を渡さないよう、
// Date.parse には3桁に切り詰めた文字を渡す。時差の無い時刻・読めない時刻は NaN。
function vdTime(value) {
  const m = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})$/.exec(value);
  if (!m) return NaN;
  const fraction = (m[2] || '').padEnd(6, '0'), zone = m[3] === 'Z' ? 'Z' : m[3].replace(/^([+-]\d{2}):?(\d{2})$/, '$1:$2');
  const base = m[1].length === 16 ? `${m[1]}:00` : m[1]; // 秒の無い時刻
  const ms = Date.parse(`${base}.${fraction.slice(0, 3)}${zone}`);
  return Number.isFinite(ms) ? ms * 1000 + Number(fraction.slice(3, 6)) : NaN;
}
// 記録として保存できない理由（旧経路の Dart も表示で飛ばす内容）。問題が無ければ null。
function vdRowProblem(row, day) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return 'not-object';
  if (!vdDay(row.day) || (day !== undefined && row.day !== day)) return 'day';
  if (typeof row.store !== 'string' || !row.store) return 'store';
  if (typeof row.machine !== 'string') return 'machine';
  if (!Number.isSafeInteger(row.rack) || row.rack < 1) return 'rack';
  return null;
}
// 印・イベント・削除情報の1件の識別と、使えない理由（旧経路の Dart もその1件を無視する内容）。問題が無ければ null。
const vdAnnotationId = (field, row) => JSON.stringify(field === 'date_events' ? [row.store, row.day]
  : field === 'rainbow_marks' ? [row.store, row.day, row.rack] : [row.store, row.day, row.machine, row.rack]);
function vdAnnotationProblem(field, row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return 'not-object';
  if (!vdDay(row.day)) return 'day';
  if (typeof row.store !== 'string') return 'store';
  const clock = field === 'record_deletions' ? 'deleted_at' : 'updated_at', at = vdTime(row[clock]);
  if (row[clock] !== undefined && !Number.isFinite(at)) return 'time';
  if (field === 'rainbow_marks' && (typeof row.on !== 'boolean' || !Number.isSafeInteger(row.rack) || row.rack < 1 || !Number.isFinite(at))) return 'mark';
  if (field === 'record_deletions' && (!Number.isFinite(at) || typeof row.machine !== 'string' || !Number.isSafeInteger(row.rack))) return 'deletion';
  if (field === 'date_events' && !(typeof row.name === 'string' || row.name === null && Number.isFinite(at))) return 'event';
  return null;
}
// 同じキーの記録の余分な件数。
function vdDuplicates(rows) {
  const keys = new Set(); let extra = 0;
  for (const row of rows) { const key = vdKey(row); if (keys.has(key)) extra++; else keys.add(key); }
  return extra;
}
// allowDuplicates：旧本文から移した日だけ、同じキーの記録をそのまま残す（旧経路の Dart は1台にまとめて表示する。
// 2026-10-30 利用者「取り込んだうえで印を付ける」）。新しい書き込み・Googleの部品は従来どおり重複を拒否する。
function vdRows(rows, day, {allowDuplicates = false} = {}) {
  if (!Array.isArray(rows)) vdFail('日別の記録が配列ではありません。');
  for (const row of rows) if (vdRowProblem(row, day)) vdFail('記録のキー・日付が不正です。');
  if (!allowDuplicates && vdDuplicates(rows)) vdFail('同じキーの記録が重複しています。');
  return rows;
}
function vdHead(head) {
  if (!head) return {schema: 1, revision: 0, days: {}, metadata: {}};
  if (head.schema !== 1 || !Number.isSafeInteger(head.revision) || head.revision < 1 ||
      !head.days || Array.isArray(head.days) || !head.metadata || Array.isArray(head.metadata)) vdFail('日別索引が破損しています。');
  for (const [day, value] of Object.entries(head.days)) {
    if (!vdDay(day) || !['complete', 'empty', 'deleted'].includes(value?.state) || !Array.isArray(value.shards)) vdFail('日別索引が破損しています。');
    if (new Set(value.shards.map(s => s.store)).size !== value.shards.length) vdFail('店舗索引が重複しています。');
    for (const shard of value.shards) if (typeof shard.store !== 'string' || !/^[a-f0-9]{64}$/.test(shard.hash) ||
      !Number.isSafeInteger(shard.count) || shard.count < 1 || !Number.isSafeInteger(shard.bytes)) vdFail('本文索引が破損しています。');
    if (value.duplicates !== undefined && (!Number.isSafeInteger(value.duplicates) || value.duplicates < 1)) vdFail('日別索引が破損しています。');
  }
  const q = head.migration?.quarantine;
  if (q !== undefined && (!/^[a-f0-9]{64}$/.test(q?.hash) || !Number.isSafeInteger(q.count) || q.count < 1)) vdFail('保留した記録の索引が破損しています。');
  if (head.released !== undefined && (!Array.isArray(head.released) ||
      head.released.some(r => !/^[a-f0-9]{64}$/.test(r?.hash) || !Number.isFinite(Date.parse(r.at))))) vdFail('回収待ちの一覧が破損しています。');
  return head;
}
// JSONの値の終わりだけ探す。構文検査は各行とrecordsを除いた外枠のJSON.parseで行う。
function vdValueEnd(text, start) {
  let quoted = false, escaped = false, depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') { quoted = false; if (depth === 0) return i + 1; }
    } else if (c === '"') quoted = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { if (--depth === 0) return i + 1; if (depth < 0) return i; }
    else if (depth === 0 && /[\s,:]/.test(c)) return i;
  }
  return text.length;
}
function vdLegacy(text, site) {
  if (typeof text !== 'string') vdFail('旧本文がありません。');
  const space = i => { while (/\s/.test(text[i] || '') && i < text.length) i++; return i; };
  let i = space(0), recordsStart = -1, recordsEnd = -1;
  if (text[i++] !== '{') vdFail('旧本文の外枠が不正です。');
  const names = new Set();
  while ((i = space(i)) < text.length && text[i] !== '}') {
    if (text[i] !== '"') vdFail('旧本文の項目名が不正です。');
    const end = vdValueEnd(text, i), name = JSON.parse(text.slice(i, end));
    if (names.has(name)) vdFail('旧本文の項目が重複しています。');
    names.add(name); i = space(end);
    if (text[i++] !== ':') vdFail('旧本文の区切りが不正です。');
    i = space(i); const valueEnd = vdValueEnd(text, i);
    if (name === 'records') { recordsStart = i; recordsEnd = valueEnd; }
    i = space(valueEnd);
    if (text[i] === '}') break;
    if (text[i++] !== ',') vdFail('旧本文の区切りが不正です。');
  }
  if (recordsStart < 0 || text[recordsStart] !== '[' || text[recordsEnd - 1] !== ']') vdFail('旧本文に記録配列がありません。');
  const header = JSON.parse(text.slice(0, recordsStart) + '[]' + text.slice(recordsEnd));
  if (header.version !== 1 || header.format !== (site === 'meruhen' ? 'database-backup' : 'pscube-viewer')) vdFail('旧本文の形式・版が不正です。');
  delete header.records;
  // 印・イベント・削除情報は見出しのまま legacy に保存し、表示の時に旧経路と同じ規則で選り分ける。配列でなければ
  // 旧経路も読めないので止めるが、旧経路が無視するだけの1件（時刻なし・存在しない日付など）では止めず、件数を残す
  // （2026-10-30 利用者「取り込んだうえで印を付ける」）。
  const ignored = {};
  for (const field of VD_ANNOTATION_FIELDS) {
    if (header[field] === undefined) continue;
    if (!Array.isArray(header[field])) vdFail('旧本文の印・イベント・削除情報が配列ではありません。');
    const bad = header[field].filter(v => vdAnnotationProblem(field, v)).length;
    if (bad) ignored[field] = bad;
  }
  // 1回目の走査は各記録の形・営業日を確かめ、日ごとに位置（開始・終了の数の並び）だけを控える。日ごとの
  // 重複と内容の指紋は vdLegacyDays が1日ずつ確かめる（全日のキーや解析済みの記録を同時に持たない、
  // 2026-10-29 レビュー指摘3）。どちらも移行を running として確定する前に済ませる（指摘1）。
  // 記録として保存できない行（台番号0・文字列、存在しない日付など、旧経路の Dart も飛ばす行）は捨てずに「保留」へ
  // 位置と理由だけを控える（2026-10-30）。JSONとして読めない行は旧経路も読めないので止める。
  const offsets = new Map(), quarantine = {spans: [], reasons: []}; let count = 0;
  i = space(recordsStart + 1);
  while (i < recordsEnd - 1) {
    const end = vdValueEnd(text, i), row = JSON.parse(text.slice(i, end)), problem = vdRowProblem(row);
    if (problem) { quarantine.spans.push(i, end); quarantine.reasons.push(problem); }
    else {
      if (!offsets.has(row.day)) offsets.set(row.day, []);
      offsets.get(row.day).push(i, end); count++;
    }
    i = space(end);
    if (i === recordsEnd - 1) break;
    if (text[i++] !== ',') vdFail('旧本文の記録区切りが不正です。');
    i = space(i);
    if (i === recordsEnd - 1) vdFail('旧本文の末尾カンマは不正です。');
  }
  // 明示された空の日も移す。期間内の穴から削除や空を推測しない。
  if (header.history_days !== undefined && !Array.isArray(header.history_days)) vdFail('旧本文の日一覧が配列ではありません。');
  for (const day of header.history_days || []) {
    if (!vdDay(day)) { ignored.history_days = (ignored.history_days || 0) + 1; continue; }
    if (!offsets.has(day)) offsets.set(day, []);
  }
  return {header, offsets, count, quarantine, ignored};
}
// 控えた位置から、その日の記録だけを解析する。
const vdDayRows = (text, spans) => {
  const rows = [];
  for (let k = 0; k < spans.length; k += 2) rows.push(JSON.parse(text.slice(spans[k], spans[k + 1])));
  return rows;
};
// 記録キー・件数・全項目（印・削除時刻を含む）の、並び順に依存しない指紋。受領の照合にも使う。
const vdFingerprint = values => vpClientHash(vpCanonical([...values].sort((a, b) => vdKey(a).localeCompare(vdKey(b)))));
// 2回目の走査：1日ずつ解析して重複を確かめ、日ごとの指紋を作る。旧本文の指紋は、見出しと日ごとの指紋から作る
// （全文をUTF-8に複製してハッシュしない。365日の初回移行で全文の写しが山を押し上げていた、レビュー指摘3）。
async function vdLegacyDays(text, parsed) {
  const days = new Map();
  for (const [day, spans] of [...parsed.offsets].sort(([a], [b]) => a.localeCompare(b))) {
    const rows = vdDayRows(text, spans), duplicates = vdDuplicates(rows);
    vdRows(rows, day, {allowDuplicates: true});
    days.set(day, {hash: await vdFingerprint(rows), count: rows.length, ...(duplicates ? {duplicates} : {})});
  }
  // 保留した行は、旧本文の並びのまま理由を添えて1つの本文にする。
  const held = vdDayRows(text, parsed.quarantine.spans).map((row, k) => ({reason: parsed.quarantine.reasons[k], row}));
  const quarantine = held.length ? {rows: held, hash: await vpClientHash(vpCanonical(held))} : null;
  const sourceHash = await vpClientHash(vpCanonical({version: 3, header: parsed.header, days: [...days], quarantine: quarantine?.hash ?? null}));
  return {days, sourceHash, quarantine};
}
function createViewerDayStore({dbName = VD_DB} = {}) {
  async function open() {
    if (!globalThis.indexedDB) throw vdError('unavailable', '端末の保存領域を利用できません。');
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => { for (const s of ['heads', 'bodies']) request.result.createObjectStore(s); };
      let blocked = false;
      request.onblocked = () => { blocked = true; reject(vdError('blocked', '別のタブが保存領域を使用しています。')); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
    });
  }
  async function transaction(names, mode, action) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(names, mode); let result, failure;
        const fail = error => { if (failure) return; failure = error; try { tx.abort(); } catch { /* 既に終了 */ } };
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(failure || tx.error || vdError('aborted', '保存処理が中断されました。'));
        tx.onerror = () => { /* abortで失敗を返す。 */ };
        try { action(tx, value => { result = value; }, fail); } catch (error) { fail(error); }
      });
    } finally { db.close(); }
  }
  const read = (store, key) => transaction([store], 'readonly', (tx, done) => {
    const request = tx.objectStore(store).get(key); request.onsuccess = () => done(request.result);
  });
  const inspect = async key => {
    const saved = await read('heads', key);
    if (!saved) return vdHead(null);
    if (!saved.value || await vpClientHash(vpCanonical(saved.value)) !== saved.hash) vdFail('索引の照合値が一致しません。');
    return vdHead(saved.value);
  };
  const bodyKey = (key, hash) => JSON.stringify([key, hash]);
  async function readBody(key, ref) {
    const text = await read('bodies', bodyKey(key, ref.hash));
    if (typeof text !== 'string') throw vdError('missing', '確定済み本文がありません。');
    if (new TextEncoder().encode(text).length !== ref.bytes || await vpClientHash(text) !== ref.hash) vdFail('確定済み本文の照合値が一致しません。');
    return JSON.parse(text);
  }
  async function stage(key, value) {
    const text = vpCanonical(value), ref = {hash: await vpClientHash(text), bytes: new TextEncoder().encode(text).length};
    await transaction(['bodies'], 'readwrite', (tx, done) => { tx.objectStore('bodies').put(text, bodyKey(key, ref.hash)); done(ref); });
    // 書き戻した本文を読み、照合が済んだ参照だけを索引へ公開する。
    if (vpCanonical(await readBody(key, ref)) !== text) vdFail('書き戻した本文が一致しません。');
    return ref;
  }
  // 索引の比較確定。参照が外れた本文は released に時刻つきで控え（collect が猶予後に消す）、新しく参照する
  // 本文は同じトランザクションで実在を確かめる（回収と重なって消えた本文を指す索引を作らない、レビュー指摘2）。
  async function publish(key, expected, next) {
    const before = vpCanonical(expected), oldRefs = vdRefs(expected), newRefs = vdRefs(next), at = new Date().toISOString();
    const released = (expected.released || []).filter(r => !newRefs.has(r.hash)), known = new Set(released.map(r => r.hash));
    for (const hash of oldRefs) if (!newRefs.has(hash) && !known.has(hash)) released.push({hash, at});
    if (released.length) next.released = released; else delete next.released;
    const unchanged = before === vpCanonical(next);
    if (!unchanged) next.revision = expected.revision + 1;
    const hash = await vpClientHash(vpCanonical(next)), added = [...newRefs].filter(h => !oldRefs.has(h));
    return transaction(['heads', 'bodies'], 'readwrite', (tx, done, fail) => {
      const store = tx.objectStore('heads'), bodies = tx.objectStore('bodies'), request = store.get(key);
      request.onsuccess = () => {
        try {
          const current = vdHead(request.result?.value);
          if (vpCanonical(current) !== before) throw vdError('conflict', 'ほかの処理が先に確定しました。再読込が必要です。');
          if (unchanged) { done(next); return; }
          const commit = () => { store.put({value: next, hash}, key); done(next); };
          let pending = added.length;
          if (!pending) { commit(); return; }
          for (const h of added) {
            const check = bodies.getKey(bodyKey(key, h));
            check.onsuccess = () => {
              if (check.result === undefined) fail(vdError('missing', '確定する本文がありません（回収と重なりました）。やり直してください。'));
              else if (--pending === 0) commit();
            };
          }
        } catch (e) { fail(e); }
      };
    });
  }
  // 参照が外れてから graceMs 以上たった本文を消す。索引の比較と本文の削除を1つのトランザクションで行うので、
  // その間に別の確定が同じ本文を参照し直していれば conflict で止まり、何も消さない。旧本文・旧経路には触れない。
  // 確定前に失敗して索引に載らなかった本文（released に無いもの）はここでは消さない。
  async function collect(key, {graceMs = VD_GRACE_MS, now = Date.now()} = {}) {
    const head = await inspect(key), refs = vdRefs(head);
    const due = (head.released || []).filter(r => now - Date.parse(r.at) >= graceMs && !refs.has(r.hash)).map(r => r.hash);
    if (!due.length) return {removed: 0, revision: head.revision};
    const gone = new Set(due), next = structuredClone(head);
    next.released = head.released.filter(r => !gone.has(r.hash));
    if (!next.released.length) delete next.released;
    next.revision = head.revision + 1;
    const before = vpCanonical(head), hash = await vpClientHash(vpCanonical(next));
    return transaction(['heads', 'bodies'], 'readwrite', (tx, done, fail) => {
      const store = tx.objectStore('heads'), request = store.get(key);
      request.onsuccess = () => {
        try {
          if (vpCanonical(vdHead(request.result?.value)) !== before) throw vdError('conflict', 'ほかの処理が先に確定しました。回収は次の機会に行います。');
          for (const h of due) tx.objectStore('bodies').delete(bodyKey(key, h));
          store.put({value: next, hash}, key);
          done({removed: due.length, revision: next.revision});
        } catch (e) { fail(e); }
      };
    });
  }
  async function prepareDay(key, day, update, previous, {allowDuplicates = false} = {}) {
    if (!vdDay(day) || !update || !['complete', 'deleted'].includes(update.state)) vdFail('日別更新の状態が不正です。');
    const rows = vdRows(update.records, day, {allowDuplicates}), groups = new Map(), duplicates = vdDuplicates(rows);
    if (update.state === 'deleted' && (rows.length || !Number.isFinite(vdTime(update.deleted_at)))) vdFail('明示削除には削除時刻（時差つき）と空の本文が必要です。');
    for (const row of rows) { if (!groups.has(row.store)) groups.set(row.store, []); groups.get(row.store).push(row); }
    const shards = [];
    for (const [store, items] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      // 入力の順序も本文の一部として保存し、未知の項目や外した印の時刻を削らない。
      const value = {day, store, records: items}, text = vpCanonical(value), hash = await vpClientHash(text);
      const old = previous?.shards.find(s => s.store === store && s.hash === hash);
      shards.push({...old || await stage(key, value), store, count: items.length});
    }
    return {state: update.state === 'deleted' ? 'deleted' : rows.length ? 'complete' : 'empty', shards,
      ...(duplicates ? {duplicates} : {}),
      ...(update.deleted_at ? {deleted_at: update.deleted_at} : {}),
      ...(update.parts ? {parts: update.parts} : {})};
  }
  // 呼出側が統合済みの完成日を渡す。未取得・通信失敗を空配列にして呼んではならない。
  async function writeDays(key, {expectedRevision, updates = {}, metadata = {}}) {
    updates = structuredClone(updates); metadata = structuredClone(metadata);
    const head = await inspect(key);
    if (head.revision !== expectedRevision) throw vdError('conflict', '更新開始時の版が一致しません。');
    if (head.migration?.status === 'running') throw vdError('migration-running', '旧本文の移行が未完了です。旧経路を利用してください。');
    const next = structuredClone(head);
    for (const [day, update] of Object.entries(updates)) next.days[day] = await prepareDay(key, day, update, head.days[day]);
    for (const [source, value] of Object.entries(metadata)) {
      const hash = await vpClientHash(vpCanonical(value));
      next.metadata[source] = head.metadata[source]?.hash === hash ? head.metadata[source] : await stage(key, value);
    }
    return publish(key, head, next);
  }
  function select(head, range) {
    if (!range || (!Array.isArray(range.days) && !(vdDay(range.from) && vdDay(range.to)))) throw vdError('range-required', '日一覧または開始日・終了日を指定してください。');
    if (range.days?.some(d => !vdDay(d)) || (range.from && range.from > range.to)) throw vdError('invalid-range', '読み込む範囲が不正です。');
    if (range.stores !== undefined && (!Array.isArray(range.stores) || range.stores.some(s => typeof s !== 'string'))) throw vdError('invalid-range', '店舗範囲が不正です。');
    return range.days ? [...new Set(range.days)].sort() : Object.keys(head.days).filter(d => d >= range.from && d <= range.to).sort();
  }
  async function* streamRange(key, range) {
    const head = await inspect(key), days = select(head, range);
    // 不変本文への参照を固定するため、途中で他タブが確定しても旧版の一貫した範囲を返せる。
    for (const day of days) {
      const descriptor = head.days[day], records = [];
      if (!descriptor) { yield {day, state: 'unfetched', revision: head.revision, records}; continue; }
      for (const shard of descriptor.shards) {
        if (range.stores && !range.stores.includes(shard.store)) continue;
        const body = await readBody(key, shard);
        if (body.day !== day || body.store !== shard.store || body.records?.length !== shard.count || body.records.some(r => r.store !== shard.store)) vdFail('本文と索引の範囲が一致しません。');
        vdRows(body.records, day, {allowDuplicates: Boolean(descriptor.duplicates)}); records.push(...body.records);
      }
      yield {day, state: descriptor.state, revision: head.revision, records,
        ...(descriptor.duplicates ? {duplicates: descriptor.duplicates} : {}), ...(descriptor.deleted_at ? {deleted_at: descriptor.deleted_at} : {})};
    }
  }
  async function readRange(key, range) { const days = []; for await (const day of streamRange(key, range)) days.push(day); return days; }
  // 移行で保留した行（理由つき、旧本文の並び）。無ければ空の配列。
  async function readQuarantine(key, head) {
    head ||= await inspect(key);
    return head.migration?.quarantine ? readBody(key, head.migration.quarantine) : [];
  }
  async function readMetadata(key, source, head) {
    head ||= await inspect(key);
    const value = head.metadata[source] ? await readBody(key, head.metadata[source]) : null;
    // 'parts' は見出しと印・イベント・削除情報を合わせて返す（分ける前と同じ形）。
    if (source === 'parts' && value && head.metadata[VD_ANNOTATIONS]) return {...value, ...await readBody(key, head.metadata[VD_ANNOTATIONS])};
    return value;
  }
  async function migrateLegacy(key, {text, site, maxDays = Infinity, signal} = {}) {
    if (!['meruhen', 'pscube'].includes(site) || !(maxDays === Infinity || Number.isInteger(maxDays) && maxDays >= 0)) vdFail('移行条件が不正です。');
    const parsed = vdLegacy(text, site);
    const {days: prints, sourceHash, quarantine} = await vdLegacyDays(text, parsed);
    let head = await inspect(key);
    // 版1（全文のハッシュ）・版2（保留・重複の扱いの前）とは指紋の作り方が違い、同じ旧本文でも一致しない。捨ててやり直す。
    if (head.migration && head.migration.version !== 3) throw vdError('migration-version', '古い版の移行です。abandonMigration で捨ててからやり直してください。');
    if (head.migration && head.migration.sourceHash !== sourceHash) throw vdError('source-changed', '旧本文が変わりました。別の移行領域で照合してください。');
    if (!head.migration) {
      // 版の番号ではなく中身で判断する（abandonMigration で捨てた後の空の領域からは始め直せる）。
      if (Object.keys(head.days).length || Object.keys(head.metadata).length) throw vdError('not-empty', '移行先に既存の確定内容があります。');
      const ref = await stage(key, parsed.header);
      // 保留した行（旧経路も表示で飛ばす行）は理由つきで別の本文に残し、件数と理由ごとの数を移行の記録に書く。
      const held = quarantine ? {...await stage(key, quarantine.rows), count: quarantine.rows.length,
        reasons: quarantine.rows.reduce((n, r) => ({...n, [r.reason]: (n[r.reason] || 0) + 1}), {})} : null;
      const duplicates = [...prints.values()].reduce((n, d) => n + (d.duplicates || 0), 0);
      head = await publish(key, head, {...head, metadata: {legacy: ref}, migration: {
        version: 3, sourceHash, status: 'running', totalDays: parsed.offsets.size, totalRecords: parsed.count, receipts: {},
        ...(held ? {quarantine: held} : {}), ...(duplicates ? {duplicates} : {}),
        ...(Object.keys(parsed.ignored).length ? {ignored: parsed.ignored} : {})}});
    }
    const alreadyComplete = head.migration.status === 'complete';
    if (vpCanonical(await readMetadata(key, 'legacy', head)) !== vpCanonical(parsed.header)) vdFail('旧本文の見出しが一致しません。');
    let processed = 0;
    for (const [day, spans] of [...parsed.offsets].sort(([a], [b]) => a.localeCompare(b))) {
      signal?.throwIfAborted();
      const {hash, count} = prints.get(day), receipt = head.migration.receipts[day];
      if (receipt) {
        // 受領済みの日は旧本文を解析し直さず、保存した本文の指紋を確かめる。
        const saved = {records: []};
        for (const ref of receipt.shards) saved.records.push(...(await readBody(key, ref)).records);
        if (receipt.hash !== hash || receipt.count !== count || await vdFingerprint(saved.records) !== hash) vdFail('移行済みの日の照合に失敗しました。');
        continue;
      }
      if (processed >= maxDays) return head;
      const rows = vdDayRows(text, spans);
      if (rows.length !== count || await vdFingerprint(rows) !== hash) vdFail('旧本文が移行中に変わりました。');
      const next = structuredClone(head);
      next.days[day] = await prepareDay(key, day, {state: 'complete', records: rows}, undefined, {allowDuplicates: true});
      next.migration.receipts[day] = {hash, count: rows.length, shards: next.days[day].shards};
      head = await publish(key, head, next); processed++;
    }
    // 本文・見出し・全日の受領がそろったときだけ完了。旧本文は一切書き換えない。
    if (Object.keys(head.migration.receipts).length !== parsed.offsets.size || Object.values(head.migration.receipts).reduce((n, r) => n + r.count, 0) !== parsed.count) vdFail('移行の照合件数が一致しません。');
    if (alreadyComplete) return head;
    const next = structuredClone(head); next.migration.status = 'complete';
    return publish(key, head, next);
  }
  // 未完了の移行領域を捨てて、別の旧本文で始め直せるようにする（2026-10-29 レビュー指摘1）。running の間は
  // 通常更新を拒否しているので、索引にあるのは移行で入れた日と見出しだけ。それを確かめてから空の索引を
  // 比較確定する。旧本文・旧経路には触れない。捨てた本文は released に入り、collect が猶予後に消す。完了した移行は捨てない。
  async function abandonMigration(key) {
    const head = await inspect(key);
    if (!head.migration) throw vdError('no-migration', '捨てる移行がありません。');
    if (head.migration.status !== 'running') throw vdError('migration-complete', '完了した移行は捨てません。');
    const migrated = new Set(Object.keys(head.migration.receipts));
    if (Object.keys(head.days).some(day => !migrated.has(day)) || Object.keys(head.metadata).some(source => source !== 'legacy')) {
      throw vdError('not-migration-only', '移行以外の確定内容があるため捨てられません。');
    }
    return publish(key, head, {schema: 1, revision: head.revision, days: {}, metadata: {},
      abandonedMigration: {sourceHash: head.migration.sourceHash, days: migrated.size, at: new Date().toISOString()}});
  }
  function mergeMetadata(previous, incoming) {
    const result = {...previous, ...incoming};
    for (const field of VD_ANNOTATION_FIELDS) {
      if (previous?.[field] === undefined && incoming[field] === undefined) continue;
      const entries = new Map();
      for (const [which, list] of [[0, previous?.[field]], [1, incoming[field]]]) {
        if (list === undefined) continue;
        if (!Array.isArray(list)) vdFail('印・イベント・削除情報が配列ではありません。');
        for (const row of list) {
          const problem = vdAnnotationProblem(field, row);
          if (problem) vdFail(`印・イベント・削除情報が不正です（${problem}）。`);
          const id = vdAnnotationId(field, row), old = entries.get(id), clock = field === 'record_deletions' ? 'deleted_at' : 'updated_at';
          const at = vdTime(row[clock]), before = vdTime(old?.[clock]);
          // 同じ時刻なら届いた側を採る（既存の mergeRainbowMarks・mergeDateEvents と同じ）。比べるのはマイクロ秒まで。
          if (!old || Number.isFinite(at) && (!Number.isFinite(before) || at >= before) || !which) entries.set(id, row);
        }
      }
      result[field] = [...entries.values()];
    }
    return result;
  }

  // v2日別通信の別入口。既存fetchViewerPartsと異なり、戻り値に全recordsを作らない。
  async function syncParts(url, site, manifest, getJson) {
    const m = vpValidManifest(structuredClone(manifest), site);
    if (m.version !== 2) throw vdError('legacy-manifest', '範囲を明示するv2一覧が必要です。旧経路を利用してください。');
    const key = vpEndpointKey(url, site), head = await inspect(key);
    if (head.migration?.status === 'running') throw vdError('migration-running', '移行中は旧経路を利用してください。');
    const stamp = Date.parse(m.header.exported_at);
    if (!Number.isFinite(stamp)) vdFail('更新一覧の時刻が不正です。');
    if (head.partsSource && (stamp < head.partsSource.at || stamp === head.partsSource.at && m.revision !== head.partsSource.revision)) throw vdError('stale', '古い、または同時刻で異なる一覧は確定できません。');
    const next = structuredClone(head);
    for (const day of m.days) {
      const refs = m.parts.filter(p => p.day === day), signature = refs.map(p => ({hash: p.hash, bytes: p.bytes, count: p.count}));
      if (vpCanonical(head.days[day]?.parts) === vpCanonical(signature)) continue;
      // 端末で明示削除した日（2026-10-29 レビュー指摘5で決めた規則）：Googleも空なら、削除時刻つきの削除を残す
      // （どちらも記録なしで、削除の時刻を失わない）。Googleに記録があっても、書き出しが削除より前なら戻さない。
      // 削除より後の書き出しの記録なら、Googleの内容で置き換える（時刻の新しい方、ほかの印・削除情報と同じ考え方）。
      // 書き出し時刻が読めない（時差なしなど）ときは、新しいと言えないので削除を残す。
      const current = head.days[day];
      if (current?.state === 'deleted' && (!refs.length || !(vdTime(m.header.exported_at) > vdTime(current.deleted_at)))) continue;
      const rows = [];
      for (let i = 0; i < refs.length; i += VP_BATCH) {
        const batch = refs.slice(i, i + VP_BATCH), request = new URL(url); request.search = ''; request.hash = '';
        if (site === 'pscube') request.searchParams.set('file', 'pscube');
        request.searchParams.set('revision', m.revision); request.searchParams.set('parts', batch.map(p => p.hash).join(','));
        const response = await getJson(request.href);
        if (response?.format !== VP_FORMAT || response.revision !== m.revision || response.parts?.length !== batch.length) throw vdError('remote-changed', '取得中に一覧の版が変わりました。');
        for (let j = 0; j < batch.length; j++) {
          const ref = batch[j], item = response.parts[j];
          if (item?.hash !== ref.hash || typeof item.text !== 'string' || new TextEncoder().encode(item.text).length !== ref.bytes || await vpClientHash(item.text) !== ref.hash) vdFail('受信した部品が一致しません。');
          rows.push(...vpRows(item.text, ref));
        }
      }
      next.days[day] = await prepareDay(key, day, {state: 'complete', records: rows, parts: signature}, head.days[day]);
    }
    // 旧本文由来の印・イベント・削除情報は別の見出しに残す。表示時の統合規則は既存側の責務。
    const input = {...m.header, ...vpPublicCurves(m)};
    const inputHash = await vpClientHash(vpCanonical(input));
    if (head.partsSource?.headerHash !== inputHash) {
      // 本文とは別の補助情報。期間外になった印・イベント・削除情報も保持する。見出しと印などを別の本文にし、
      // 中身が同じなら前の本文をそのまま使う（書き出し時刻だけの変化で印などを書き直さない）。
      const merged = mergeMetadata(await readMetadata(key, 'parts', head), input);
      const annotations = Object.fromEntries(VD_ANNOTATION_FIELDS.filter(f => merged[f] !== undefined).map(f => [f, merged[f]]));
      const summary = Object.fromEntries(Object.entries(merged).filter(([f]) => !VD_ANNOTATION_FIELDS.includes(f)));
      for (const [source, value] of [['parts', summary], [VD_ANNOTATIONS, annotations]]) {
        const hash = await vpClientHash(vpCanonical(value));
        next.metadata[source] = head.metadata[source]?.hash === hash ? head.metadata[source] : await stage(key, value);
      }
    }
    next.partsSource = {at: stamp, revision: m.revision, headerHash: inputHash};
    return publish(key, head, next);
  }
  return {inspect, writeDays, readRange, streamRange, readMetadata, readQuarantine, migrateLegacy, abandonMigration, syncParts, collect};
}

export {fetchViewerParts, fetchViewerDocument, fetchViewerCurves, rememberViewerHistory, readViewerHistory, createViewerDayStore};
