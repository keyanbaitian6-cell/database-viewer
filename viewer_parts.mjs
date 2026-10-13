// 生成元: tool/build_viewer_parts.mjs
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
  if (!m || m.format !== VP_FORMAT || m.version !== 1 || m.site !== site ||
      !['meruhen', 'pscube'].includes(site) || !/^[a-f0-9]{64}$/.test(m.revision) ||
      !m.header || typeof m.header !== 'object' || Array.isArray(m.header) || 'records' in m.header ||
      m.header.version !== 1 || m.header.format !== (site === 'meruhen' ? 'database-backup' : 'pscube-viewer') ||
      typeof m.header.exported_at !== 'string' || !Array.isArray(m.parts) || m.parts.length > 1024) fail();
  const seen = new Set(); let bytes = 0, count = 0;
  for (const p of m.parts) {
    if (!p || !/^[a-f0-9]{64}$/.test(p.hash) || seen.has(p.hash) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(p.day) || !Number.isSafeInteger(p.count) || p.count < 1 ||
        !Number.isSafeInteger(p.bytes) || p.bytes < 2 || p.bytes > VP_PART_BYTES) fail();
    seen.add(p.hash); bytes += p.bytes; count += p.count;
  }
  if (bytes > VP_MAX_BYTES || count > 100000 || count !== m.count) fail();
  return m;
}
function vpPublic(m) {
  return {format: m.format, version: m.version, site: m.site, revision: m.revision,
    header: m.header, count: m.count, parts: m.parts.map(({hash, day, count, bytes}) => ({hash, day, count, bytes}))};
}
function vpRows(text, part) {
  const rows = JSON.parse(text);
  if (!Array.isArray(rows) || rows.length !== part.count || rows.some(r => !r || r.day !== part.day)) {
    throw new Error('閲覧用の日別データが更新一覧と一致しません。');
  }
  return rows;
}

// IndexedDBは消えることがある。キャッシュが無ければ全パーツを取り直す。
// 完成した一覧だけを1トランザクションで保存し、途中の失敗で前回分を壊さない。
function vpCache() {
  async function run(key, value, writing) {
    if (!globalThis.indexedDB) return null;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('database-viewer-parts-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('snapshots');
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('cache blocked'));
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('snapshots', writing ? 'readwrite' : 'readonly');
        const op = writing ? tx.objectStore('snapshots').put(value, key) : tx.objectStore('snapshots').get(key);
        tx.oncomplete = () => { db.close(); resolve(writing ? null : op.result); };
        tx.onabort = tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  }
  return {get: key => run(key), set: (key, value) => run(key, value, true)};
}
async function vpClientHash(text) {
  const data = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(data)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function fetchViewerParts(url, site, manifest, getJson, cache = vpCache()) {
  const m = vpValidManifest(manifest, site), endpoint = new URL(url);
  endpoint.search = ''; endpoint.hash = '';
  const key = endpoint.href + '|' + site;
  let cached = null;
  try { cached = await cache.get(key); } catch { /* 保存を使えなくても読める */ }
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
  const doc = {...m.header, records: m.parts.flatMap(p => vpRows(parts.get(p.hash), p))};
  try { await cache.set(key, {parts: Object.fromEntries(parts)}); } catch { /* 容量不足なら次回全件取得 */ }
  return doc;
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

export {fetchViewerParts, fetchViewerDocument};
