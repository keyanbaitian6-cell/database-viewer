// 生成元: tool/build_viewer_parts.mjs
const SCRIPT_RELEASE = '0471b8c49eee';
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

export {fetchViewerParts, fetchViewerDocument, fetchViewerCurves, rememberViewerHistory, readViewerHistory};
