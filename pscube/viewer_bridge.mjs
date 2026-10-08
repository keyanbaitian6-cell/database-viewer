import {readWebArchive} from './archive.mjs';
import {emptyData, validateData, mergeData, parsePage, validDay, machineKey, dateEventKey, cleanEventName, mergeDateEvents, validateDateEvents} from './data.mjs';
import {applyGraphProbe} from './graph_probe.mjs';
import {REMOTE_KEY, fetchDrive, buildBackup, backupFileName} from './sync.mjs';
import {fetchShared, postShared} from '../shared_events.mjs';

// Reuse the old database and keys so the already imported records survive.
const open = () => new Promise((resolve, reject) => {
  const request = indexedDB.open('database-pscube-viewer', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('state');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
async function read() {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('state');
      const data = tx.objectStore('state').get('data'), meta = tx.objectStore('state').get('meta');
      tx.oncomplete = () => resolve({data: data.result, meta: meta.result || {}});
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
async function write(data, meta) {
  const db = await open();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('state', 'readwrite');
      const state = tx.objectStore('state'), current = state.get('data');
      let failure;
      current.onsuccess = () => {
        try {
          // Another tab or Drive refresh may have saved a graph after read().
          // Merge against the latest value inside this transaction, while
          // keeping explicit machine type edits (including null removals).
          const latest = current.result ? mergeData(validateData(current.result), data) : data;
          const types = new Map(data.machines.map(m => [machineKey(m), m.machine_type]));
          state.put(validateData({...latest, machines:latest.machines.map(m =>
            types.has(machineKey(m)) ? {...m, machine_type:types.get(machineKey(m))} : m)}), 'data');
          state.put(meta, 'meta');
        } catch (e) { failure = e; tx.abort(); }
      };
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(failure || tx.error || new Error('端末に保存できませんでした。'));
    });
  } finally { db.close(); }
}
function envelope(data, meta = {}) {
  return JSON.stringify({...validateData(data),
    header: {source: 'pscube', exported_at: meta.exported_at ?? null},
    file: meta.file ?? 'P’s CUBE', loaded_at: meta.loaded_at ?? new Date().toISOString()});
}
export async function isPscubeFile(file) {
  if (/\.webarchive$/i.test(file.name)) return true;
  const head = await file.slice(0, 4096).text();
  return head.startsWith('bplist') || head.includes('WebMainResource') ||
    /"format"\s*:\s*"pscube-viewer"/.test(head) ||
    (/"rack"\s*:/.test(head) && /"graph"\s*:/.test(head));
}
export async function readPscubeFiles(files, existing) {
  const old = existing ?? (await read()).data;
  let data = old ? validateData(old) : emptyData();
  let exportedAt = null;
  for (const file of files) {
    let fresh;
    const head = (await file.slice(0, 4096).text()).replace(/^\uFEFF/, '').trimStart();
    if (/\.webarchive$/i.test(file.name) || !head.startsWith('{')) {
      fresh = parsePage(await readWebArchive(await file.arrayBuffer()));
    } else {
      const raw = JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
      if (raw?.graph && raw?.rack) {
        data = applyGraphProbe(data, raw);
        continue;
      }
      fresh = validateData(raw); exportedAt = raw.exported_at ?? null;
    }
    data = mergeData(data, fresh);
  }
  return envelope(data, {file: files.map(f => f.name).join('、'), exported_at: exportedAt});
}
// Read and update only the event in one IDB transaction. Concurrent imports and
// other tabs cannot have their records replaced by a stale read of this page.
// name: 自由記入のイベント名。空・null は「イベントなし」（消した印として残す）。
async function setDateEvent(scope, day, name) {
  const match = /^pscube:(c\d+):(\d+(?:\.\d+)?)$/.exec(scope ?? '');
  if (!match || !validDay(day)) throw new Error('イベントの店舗・日付が不正です。');
  const cleaned = cleanEventName(name);
  const [, store, rate] = match, db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('state', 'readwrite'), state = tx.objectStore('state');
      const data = state.get('data'), meta = state.get('meta');
      let updated, failure;
      data.onsuccess = () => {
        try {
          if (!data.result) throw new Error('先にデータを読み込んでください。');
          const valid = validateData(data.result);
          if (!valid.records.some(r => r.store === store && r.rate === rate && r.day === day)) throw new Error('この店舗・日付の記録がありません。');
          const key = dateEventKey({store,rate,day});
          const previous = (valid.date_events ?? []).find(e => dateEventKey(e) === key);
          const updatedAt = new Date(Math.max(Date.now(), previous ? Date.parse(previous.updated_at) + 1 : 0)).toISOString();
          updated = validateData({...valid, date_events:[
            ...(valid.date_events ?? []).filter(e => dateEventKey(e) !== key),
            {store,rate,day,name:cleaned,updated_at:updatedAt},
          ]});
          state.put(updated, 'data');
        } catch (e) { failure = e; tx.abort(); }
      };
      tx.oncomplete = () => resolve(envelope(updated, meta.result ?? {}));
      tx.onerror = tx.onabort = () => reject(failure || tx.error || new Error('イベント名を端末に保存できませんでした。'));
    });
  } finally { db.close(); }
}

// 共有カレンダー（EVENT_CALENDAR.md、2026-10-08）：送るイベント（端末の date_events）。
async function timedEvents() {
  const saved = await read();
  return JSON.stringify(saved.data ? validateData(saved.data).date_events ?? [] : []);
}
// 共有ファイル（{format: 'database-events', events}）のイベントを端末に足す。変わらなければ null。
async function mergeShared(text) {
  let incoming;
  try {
    const doc = JSON.parse(text);
    if (!doc || doc.format !== 'database-events' || !Array.isArray(doc.events)) return null;
    incoming = validateDateEvents(doc.events);
  } catch { return null; }
  const saved = await read();
  if (!saved.data) return null;
  const valid = validateData(saved.data);
  const merged = validateData({...valid, date_events:mergeDateEvents(valid.date_events ?? [], incoming)});
  if (JSON.stringify(merged.date_events ?? []) === JSON.stringify(valid.date_events ?? [])) return null;
  await write(merged, saved.meta);
  return envelope(merged, saved.meta);
}

export function createPscubeBridge() {
  return {
    setDateEvent,
    // 共有カレンダー（P’s CUBEのページは、この橋渡しをそのまま databaseViewer に使う）。
    fetchShared,
    postShared,
    pscubeEvents: timedEvents,
    mergePscubeShared: mergeShared,
    timedEvents,
    mergeShared,
    async importGraph(text) {
      const saved = await read();
      if (!saved.data) throw new Error('先にP’s CUBEのバックアップを読み込んでください。');
      const data = applyGraphProbe(saved.data, JSON.parse(text));
      return envelope(data, {...saved.meta, file: 'P’s CUBEグラフJSON'});
    },
    pick() {
      return new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file'; input.multiple = true;
        input.oncancel = () => resolve(null);
        input.onchange = async () => {
          if (!input.files?.length) { resolve(null); return; }
          try { resolve(await readPscubeFiles([...input.files])); } catch (error) { reject(error); }
        };
        input.click();
      });
    },
    async fromUrl(url) {
      if (!url || /^[a-z]+:/i.test(url) || url.startsWith('//')) return null;
      const response = await fetch(url);
      if (!response.ok) return null;
      const doc = await response.json();
      return envelope(validateData(doc), {file: url, exported_at: doc.exported_at});
    },
    async fromRemote(url, known) {
      const result = await fetchDrive(url, known);
      if (result.unchanged) return null;
      const old = (await read()).data;
      return envelope(old ? mergeData(validateData(old), result.data) : result.data,
        {file: 'Googleドライブ（自動）', exported_at: result.exportedAt});
    },
    getRemote() { try { return localStorage.getItem(REMOTE_KEY); } catch { return null; } },
    setRemote(url) {
      try { if (url) localStorage.setItem(REMOTE_KEY, url); else localStorage.removeItem(REMOTE_KEY); } catch {}
    },
    async save(text) {
      const raw = JSON.parse(text), valid = validateData(raw), previous = await read();
      await write(previous.data ? mergeData(validateData(previous.data), valid) : valid,
        {...previous.meta, exported_at: raw.header?.exported_at ?? null,
          file: raw.file ?? 'P’s CUBE', loaded_at: raw.loaded_at ?? new Date().toISOString()});
    },
    async load() {
      const saved = await read();
      return saved.data ? envelope(saved.data, saved.meta) : null;
    },
    async exportBackup() {
      const saved = await read();
      if (!saved.data) throw new Error('まだデータを読み込んでいません。');
      const blob = new Blob([JSON.stringify(buildBackup(saved.data))], {type:'application/json'});
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = backupFileName(); a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    async setPscubeType(scope, machine, type) {
      if (![null, 'normal', 'other'].includes(type)) throw new Error('機種タイプが不正です。');
      const saved = await read();
      if (!saved.data) throw new Error('先にデータを読み込んでください。');
      const [, store, rate] = scope.split(':');
      const normalize = s => s.replaceAll('+', ' ').replace(/\s+/g, ' ').trim();
      let found = false;
      const machines = saved.data.machines.map(m => {
        if (m.store === store && m.rate === rate && normalize(m.machine) === machine) {
          found = true; return {...m, machine_type:type};
        }
        return m;
      });
      if (!found) throw new Error('機種情報がありません。');
      const data = validateData({...saved.data, machines});
      await write(data, saved.meta);
      return envelope(data, saved.meta);
    },
  };
}
