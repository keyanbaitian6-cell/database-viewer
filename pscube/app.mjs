import { readWebArchive } from './archive.mjs';
import { emptyData, parsePage, validateData, mergeData, machineKey, progress } from './data.mjs';

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
async function save(next) {
  const db = await openDB();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('state', 'readwrite');
      tx.objectStore('state').put(next, 'data');
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
  $('records').replaceChildren(...state.records.map(r => {
    const card = element('article', null, 'record'), head = element('div', null, 'record-head');
    head.append(element('h3', `${r.rack}番台`), element('span', r.graph?.kind === 'daily' ? '詳細取得済' : '詳細未取得', `badge${r.graph?.kind === 'daily' ? ' done' : ''}`));
    const stats = element('dl', null, 'stats');
    for (const [label, val] of [['BIG', r.bb], ['REG', r.rb], ['AT/ART', r.at_art], ['累計G', r.games], ['MY', r.my]]) {
      const div = element('div'); div.append(element('dt', label), element('dd', val.toLocaleString('ja-JP'))); stats.append(div);
    }
    card.append(head, stats);
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
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), a = element('a');
  a.href = url; a.download = `pscube-viewer-${new Date().toISOString().slice(0, 10)}.json`; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
};
try {
  $('files').disabled = true;
  const saved = await readSaved();
  if (saved) { data = validateData(saved); $('status').textContent = `このブラウザに保存した${data.records.length}件を表示しています。`; }
} catch (e) { error(`保存内容を開けませんでした。${e.message}`); }
finally { $('files').disabled = false; refreshFilters(); render(); }
