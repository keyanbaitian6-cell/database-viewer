import { readWebArchive } from './archive.mjs';
import { emptyData, parsePage, validateData, mergeData, machineKey, progress } from './data.mjs';
import { REMOTE_KEY, backupFileName, buildBackup, fetchDrive } from './sync.mjs';
import { scoreRecord, nextDayCandidates, bandOf, profileOf, SCORING_VERSION, MIN_SCORED_GAMES } from './scoring.mjs';

const $ = id => document.getElementById(id);
let data = emptyData(), selectedMachine = null, busy = false;
const storageName = 'database-pscube-viewer';
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(storageName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function readSaved() {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('state').objectStore('state').get('data');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
async function readMeta() {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('state').objectStore('state').get('meta');
      request.onsuccess = () => resolve(request.result || {});
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
async function save(next, meta) {
  const db = await openDB();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('state', 'readwrite');
      tx.objectStore('state').put(next, 'data');
      if (meta) tx.objectStore('state').put(meta, 'meta');
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('端末への保存に失敗しました。'));
    });
  } finally { db.close(); }
}
function error(message) { $('error').textContent = message || ''; $('error').hidden = !message; }
function element(tag, text, cls) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}
function optionList(select, items) {
  const selected = select.value;
  select.replaceChildren(...items.map(([value, label]) => {
    const option = element('option', label); option.value = value; return option;
  }));
  if (items.some(([v]) => v === selected)) select.value = selected;
}
const scope = r => `${r.store}|${r.rate}`;
function refreshFilters() {
  const scopes = [...new Set(data.machines.map(scope))];
  optionList($('store'), scopes.map(s => { const [store, rate] = s.split('|'); return [s, `${store} · ${rate}スロ`]; }));
  const days = [...new Set(data.records.filter(r => scope(r) === $('store').value).map(r => r.day))].sort().reverse();
  optionList($('day'), days.length ? days.map(d => [d, d]) : [['', '日付未取得']]);
  $('filters').hidden = !data.machines.length;
  $('export').disabled = !data.machines.length || busy;
}
function graphView(graph) {
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 340 160'); svg.classList.add('chart');
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', '保存したスランプグラフ');
  const points = graph.points, xs = points.map(p => p[0]), ys = [...points.map(p => p[1]), graph.zero_y];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const x of xs) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
  for (const y of ys) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const dx = Math.max(1, maxX - minX), dy = Math.max(1, maxY - minY);
  const x = v => 10 + (v - minX) / dx * 320, y = v => 12 + (v - minY) / dy * 136;
  const zero = document.createElementNS(ns, 'line'); zero.setAttribute('x1', '10'); zero.setAttribute('x2', '330');
  zero.setAttribute('y1', String(y(graph.zero_y))); zero.setAttribute('y2', String(y(graph.zero_y))); zero.classList.add('zero');
  const line = document.createElementNS(ns, 'polyline'); line.classList.add('curve');
  line.setAttribute('points', points.map(p => `${x(p[0]).toFixed(2)},${y(p[1]).toFixed(2)}`).join(' '));
  svg.append(zero, line); return svg;
}
const candidateCache = new WeakMap();
function candidatesOf(machine, day) {
  let perData = candidateCache.get(data);
  if (!perData) { perData = new Map(); candidateCache.set(data, perData); }
  const key = `${machineKey(machine)}|${day}`;
  if (!perData.has(key)) perData.set(key, nextDayCandidates(data, machine, day));
  return perData.get(key);
}
function candidateTally(machine, day) {
  if (!day) return '';
  const { candidates } = candidatesOf(machine, day);
  if (!candidates.length) return '';
  const stars = candidates.filter(c => c.focus).length;
  return `翌日候補 ★${stars}台・☆${candidates.length - stars}台`;
}
const scoreText = s => s.total == null ? s.reasons[0] : `${s.total.toFixed(1)}点${s.provisional ? '（暫定）' : ''}`;
function renderNextDay(machine, day) {
  const box = $('next-day'), kind = profileOf(machine) === 'normal' ? 'ノーマル（当たり頻度・出玉・グラフ）' : '出玉・グラフ';
  const panel = [element('h3', '翌日の候補（試験表示）'),
    element('p', `採点方式：${kind}（${SCORING_VERSION}）。★＝当日の情報があり、順位が安定していて、当日88点未満の台。☆＝長期傾向は上位だが★の条件を満たさない台。設定や勝ちを示すものではありません。`, 'hint')];
  const result = day ? candidatesOf(machine, day) : null;
  if (!result) panel.push(element('p', '営業日を選んでください。', 'empty'));
  else if (!result.candidates.length) panel.push(element('p', `判断できた台が${result.eligible}台（4台未満）のため、候補は出しません。台別ページの7日分を取り込むと増えます。`, 'empty'));
  else for (const c of result.candidates) {
    const row = element('div', null, `cand${c.focus ? ' focus' : ''}`);
    row.append(element('strong', `${c.focus ? '★' : '☆'} ${c.record.rack}番台`),
      element('span', `指数${c.index.toFixed(1)}・${c.usedDays}日分・当日${c.todayScore == null ? '採点なし' : `${c.todayScore.toFixed(1)}点`}`),
      element('small', `${c.reason}。日ごとの順位（新しい順）：${c.contributions.map(d => `${d.day.slice(5)} ${bandOf(d.rank)}`).join('／')}・安定性z=${c.stabilityZ.toFixed(2)}`));
    panel.push(row);
  }
  box.replaceChildren(...panel);
  return result;
}
function render() {
  const scopeMachines = data.machines.filter(m => scope(m) === $('store').value);
  $('totals').textContent = `${scopeMachines.length}機種 · 保存した台の記録 ${data.records.filter(r => scope(r) === $('store').value).length}件（日付別）`;
  const machine = scopeMachines.find(m => machineKey(m) === selectedMachine);
  $('machines').hidden = !!machine; $('detail').hidden = !machine;
  if (!machine) {
    const query = $('search').value.normalize('NFKC').toLowerCase();
    const shown = scopeMachines.filter(m => m.machine.normalize('NFKC').toLowerCase().includes(query));
    $('machines').replaceChildren(...shown.map(m => {
      const state = progress(data, m, $('day').value), button = element('button', null, 'machine'); button.type = 'button';
      button.append(element('strong', m.machine), element('span', `${state.records.length}/${m.expected_count ?? '?'}台の数値 · 詳細 ${state.records.length - state.pending.length}台`));
      if (!state.complete) button.append(element('span', '全台の数値は未確認'));
      const tally = candidateTally(m, $('day').value);
      if (tally) button.append(element('span', tally, 'tally'));
      button.onclick = () => { selectedMachine = machineKey(m); render(); $('detail').scrollIntoView({ block: 'start' }); };
      return button;
    }));
    if (!shown.length && scopeMachines.length) $('machines').append(element('p', '該当する機種はありません。', 'empty'));
    return;
  }
  const state = progress(data, machine, $('day').value);
  $('machine-name').textContent = machine.machine;
  $('machine-type').value = machine.machine_type ?? '';
  $('progress').textContent = `${state.records.length}/${machine.expected_count ?? '?'}台の数値 ${state.complete ? '確認済' : '（全台は未確認）'} · 詳細未取得 ${state.pending.length}台`;
  $('machine-link').href = machine.url;
  $('next').hidden = !state.pending.length;
  if (state.pending.length) { $('next').href = state.pending[0].detail_url; $('next').textContent = `次の未取得台 ${state.pending[0].rack} を開く`; }
  const nextDay = renderNextDay(machine, $('day').value);
  const marks = new Map((nextDay?.candidates ?? []).map(c => [c.record.rack, c.focus ? '★' : '☆']));
  $('records').replaceChildren(...state.records.map(r => {
    const card = element('article', null, 'record'), head = element('div', null, 'record-head');
    head.append(element('h3', `${r.rack}番台${marks.has(r.rack) ? ` ${marks.get(r.rack)}` : ''}`), element('span', r.graph?.kind === 'daily' ? '詳細取得済' : '詳細未取得', `badge${r.graph?.kind === 'daily' ? ' done' : ''}`));
    const stats = element('dl', null, 'stats');
    for (const [label, val] of [['BIG', r.bb], ['REG', r.rb], ['AT/ART', r.at_art], ['累計G', r.games], ['MY', r.my]]) {
      const div = element('div'); div.append(element('dt', label), element('dd', val.toLocaleString('ja-JP'))); stats.append(div);
    }
    const score = scoreRecord(r, data), line = element('p', null, 'score');
    line.append(element('strong', `採点 ${scoreText(score)}`));
    card.append(head, line, stats);
    const detail = element('details', null, 'why'); detail.append(element('summary', '採点の内訳'));
    if (score.parts) {
      const names = { hit: '当たり頻度', hold: '最大放出数（MY）', end: 'グラフ終点', retention: 'グラフ維持' };
      detail.append(element('p', Object.entries(names).filter(([k]) => score.weights[k] > 0)
        .map(([k, label]) => `${label} ${score.parts[k] == null ? '—' : score.parts[k].toFixed(1)}/${score.weights[k]}`).join('・'), 'hint'));
    }
    detail.append(...score.reasons.map(text => element('p', text, 'hint')));
    card.append(detail);
    if (r.graph) { card.append(graphView(r.graph), element('p', `${r.graph.kind === 'daily' ? '台別ページ' : '一覧ページ'}の保存グラフ · 破線はゼロ · 台ごとに縮尺が異なります`, 'graph-note')); }
    else card.append(element('p', 'グラフ未取得', 'hint'));
    const link = element('a', 'この台のサイトページを開く'); link.href = r.detail_url; link.target = '_blank'; link.rel = 'noopener noreferrer'; card.append(link);
    return card;
  }));
  if (!state.records.length) $('records').append(element('p', 'この営業日の台一覧を読み込んでください。', 'empty'));
}
async function importFiles(files) {
  if (busy || !files.length) return;
  busy = true; $('files').disabled = true; $('export').disabled = true; error(null);
  $('status').textContent = '読み込み中…';
  try {
    let next = data, imported = 0;
    for (const file of files) {
      if (file.size > 32 * 1024 * 1024) throw new Error('ファイルは32MB以下にしてください。');
      const buffer = await file.arrayBuffer();
      const prefix = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 100))).trimStart();
      const incoming = prefix.startsWith('{') ? validateData(JSON.parse(new TextDecoder().decode(buffer))) : parsePage(readWebArchive(buffer));
      next = mergeData(next, incoming); imported += incoming.records.length;
    }
    await save(next); data = next;
    $('status').textContent = `${files.length}ファイル・${imported}件の台データを確認し、このブラウザに保存しました。`;
    refreshFilters(); render();
  } catch (e) {
    error(`読み込めませんでした。${e.message}`);
    $('status').textContent = '今回の変更は保存していません。前の内容が残っています。';
  } finally { busy = false; $('files').disabled = false; $('files').value = ''; $('export').disabled = !data.machines.length; }
}
$('files').onchange = e => importFiles([...e.target.files]);
$('store').onchange = () => { selectedMachine = null; refreshFilters(); render(); };
$('day').onchange = render;
$('search').oninput = () => { selectedMachine = null; render(); };
$('back').onclick = () => { selectedMachine = null; render(); };
$('machine-type').onchange = async () => {
  if (busy) { render(); return; }
  busy = true; $('files').disabled = true; $('machine-type').disabled = true;
  try {
    const next = validateData({ ...data, machines: data.machines.map(m => machineKey(m) === selectedMachine
      ? { ...m, machine_type: $('machine-type').value || null } : m) });
    await save(next); data = next; error(null); $('status').textContent = '機種タイプを保存しました。';
  } catch (e) { error(`機種タイプを保存できませんでした。${e.message}`); }
  finally { busy = false; $('files').disabled = false; $('machine-type').disabled = false; render(); }
};
$('export').onclick = () => {
  const now = new Date();
  const blob = new Blob([JSON.stringify(buildBackup(data, now))], { type: 'application/json' });
  const url = URL.createObjectURL(blob), a = element('a');
  a.href = url; a.download = backupFileName(now); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
};
// ---- Googleドライブの自動読み込み（メルヘンの閲覧ページと同じApps Script。仕様：PSCUBE_SYNC.md） ----
const remoteUrl = () => { try { return localStorage.getItem(REMOTE_KEY); } catch { return null; } };
function setRemoteUrl(url) {
  try { if (url) localStorage.setItem(REMOTE_KEY, url); else localStorage.removeItem(REMOTE_KEY); } catch { /* 保存できなくても読み込みは使える */ }
}
function driveLabel() {
  const has = !!remoteUrl();
  $('drive-refresh').hidden = !has;
  $('drive-url').value = has ? remoteUrl() : '';
  if (!has) $('drive-status').textContent = 'Googleドライブ：未設定';
}
async function refreshDrive(manual) {
  const url = remoteUrl();
  if (!url || busy) return;
  busy = true; $('files').disabled = true; $('export').disabled = true; $('drive-refresh').disabled = true;
  $('drive-status').textContent = 'Googleドライブの最新を確認しています…';
  try {
    const meta = await readMeta().catch(() => ({}));
    const result = await fetchDrive(url, meta.exported_at);
    const time = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    if (result.unchanged) {
      $('drive-status').textContent = `Googleドライブの内容は変わっていません（${result.exportedAt}）・${time}に確認`;
    } else {
      const next = mergeData(data, result.data);
      await save(next, { exported_at: result.exportedAt, checked_at: new Date().toISOString() });
      data = next; error(null);
      $('drive-status').textContent = `Googleドライブの最新を読み込みました（${result.exportedAt ?? '時刻不明'}・${result.data.records.length}件）・${time}`;
      refreshFilters(); render();
    }
  } catch (e) {
    $('drive-status').textContent = `Googleドライブを読めませんでした：${e.message} 前の内容が残っています。`;
    if (manual) error(null);
  } finally {
    busy = false; $('files').disabled = false; $('drive-refresh').disabled = false; $('export').disabled = !data.machines.length;
  }
}
$('drive-refresh').onclick = () => refreshDrive(true);
$('drive-save').onclick = () => {
  const value = $('drive-url').value.trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(value)) {
    $('drive-status').textContent = 'GoogleのスクリプトのURL（https://script.google.com/macros/s/…/exec）を入れてください。'; return;
  }
  setRemoteUrl(value); driveLabel(); refreshDrive(true);
};
$('drive-forget').onclick = () => { setRemoteUrl(null); driveLabel(); };
try {
  $('files').disabled = true;
  const saved = await readSaved();
  if (saved) { data = validateData(saved); $('status').textContent = `このブラウザに保存した${data.records.length}件を表示しています。`; }
} catch (e) { error(`保存内容を開けませんでした。${e.message}`); }
finally { $('files').disabled = false; refreshFilters(); render(); driveLabel(); }
if (remoteUrl()) await refreshDrive(false);
