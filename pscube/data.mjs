export const FORMAT = 'pscube-viewer';
export const emptyData = () => ({ format: FORMAT, version: 1, machines: [], records: [] });
const fail = message => { throw new Error(message); };
const integer = x => Number.isSafeInteger(x) && x >= 0;
export const machineKey = r => JSON.stringify([r.store, r.rate, r.machine]);
export const recordKey = r => JSON.stringify([r.store, r.rate, r.machine, r.rack, r.day]);
export function validDay(day) {
  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
}
const graphSafe = value => Number.isSafeInteger(value) && Math.abs(value) <= 10000000;
const graphDay = value => {
  if (!Number.isSafeInteger(value) || !/^\d{8}$/.test(String(value))) fail('グラフの日付が不正です。');
  const day = dayFromCompact(String(value));
  if (!validDay(day)) fail('グラフの日付が不正です。');
  return day;
};

/** P’s CUBEの連続グラフの元数値。各日の始点と終点の差がその日の差枚。 */
export function netMedalsOfProbe(raw) {
  const rack = typeof raw?.rack === 'string' && /^\d+$/.test(raw.rack) ? Number(raw.rack) : raw?.rack;
  if (!raw || !Number.isSafeInteger(rack) || rack < 1 ||
      !/^\d{8}$/.test(raw.day ?? '') || !raw.graph ||
      !Array.isArray(raw.graph.datas?.g) || !Array.isArray(raw.graph.datas?.p) ||
      raw.graph.datas.g.length < 1 || raw.graph.datas.g.length > 7 ||
      raw.graph.datas.p.length > 50000) fail('P’s CUBEのグラフJSONではありません。');
  const selectedDay = graphDay(Number(raw.day));
  const factor = raw.graph.anjYUnit ?? 1;
  if (!Number.isFinite(factor) || factor <= 0 || factor > 100000) fail('グラフの単位が不正です。');
  const found = new Map(), fields = new Set();
  for (const line of raw.graph.datas.g) {
    const day = graphDay(line.YMD_biz), x = line.xField, y = line.yField;
    if (day > selectedDay || found.has(day) || typeof x !== 'string' || typeof y !== 'string' ||
        !/^out-\d+$/.test(x) || !/^value-\d+$/.test(y) || fields.has(y)) fail('グラフの日付・系列が不正です。');
    fields.add(y);
    const points = raw.graph.datas.p.filter(p => p && Object.hasOwn(p, x) && Object.hasOwn(p, y));
    if (points.length < 2 || points.some((p, i) => !graphSafe(p[x]) || !graphSafe(p[y]) ||
        (i && p[x] < points[i - 1][x]))) fail('グラフの元数値が不正です。');
    const net = (points.at(-1)[y] - points[0][y]) * factor;
    if (!Number.isSafeInteger(net) || Math.abs(net) > 1000000) fail('差枚の数値が不正です。');
    found.set(day, net);
  }
  if (!found.has(selectedDay)) fail('選択日のグラフがありません。');
  return found;
}

/** PC/Androidの台別ページ取得。サイト自身の認証済み通信を使い、差枚を同じ記録に載せる。
 *
 * 差枚の元データが取れない（通信失敗・拒否・形式の違い）ときも、台別の数値・グラフは今までどおり
 * 返して保存させ、差枚は空欄のまま（0にしない）`net_warning` に理由を付ける。巡回を止めないため
 * （利用者の選択、2026-10-03）。翌日以降にその台を開けば、過去6日分の差枚もそこで埋まる。 */
export async function capturePageWithNet(page, site = window) {
  const captured = parsePage(page);
  const url = siteUrl(page.url);
  if (!url.pathname.endsWith('nc-v06-001.php')) return captured;
  const rack = Number(url.searchParams.get('cd_dai'));
  const day = url.hash.slice(1);
  try {
    if (!site.api?.apikey || !site.api?.token || typeof site.jQuery?.ajax !== 'function') {
      fail('サイトの通信の準備ができていません');
    }
    const response = await new Promise((resolve, reject) => {
      site.jQuery.ajax({
        url: 'nc-m06-003.php',
        data: {cd_dai: String(rack), YMD_biz: day,
          apikey: site.api.apikey, _i: site.api.token._i, _t: site.api.token._t},
        dataType: 'json', timeout: 12000,
      }).done(resolve).fail((xhr) => reject(new Error(`通信に失敗しました（HTTP ${xhr?.status ?? '?'}）`)));
    });
    const values = netMedalsOfProbe({rack, day, graph: response?.Graph?.src});
    return validateData({...captured, records:captured.records.map(record => ({
      ...record, ...(values.has(record.day) ? {net_medals: values.get(record.day)} : {}),
    }))});
  } catch (error) {
    return {...captured, net_warning: `差枚は未取得：${String(error?.message ?? error).slice(0, 120)}`};
  }
}
function dayFromCompact(s) {
  if (!/^\d{8}$/.test(s || '')) fail('営業日を特定できません。日付を選んで保存してください。');
  const day = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`;
  if (!validDay(day)) fail('営業日が不正です。');
  return day;
}
export function siteUrl(raw, base) {
  const u = new URL(raw, base);
  if (u.origin !== 'https://www.pscube.jp' || u.username || u.password ||
      !/^\/dedamajyoho-P-townDMMpachi\/c\d+\/cgi-bin\/nc-v(?:03-001|05-011|06-001)\.php$/.test(u.pathname)) {
    fail('対象のP’s CUBEページではありません。');
  }
  return u;
}
function storeOf(url) { return url.pathname.match(/\/(c\d+)\//)[1]; }
function sameStore(raw, store) {
  const u = siteUrl(raw);
  if (storeOf(u) !== store) fail('店舗が異なるリンクが含まれています。');
  return u;
}
const text = node => node?.textContent?.trim() || '';
function numberText(raw) {
  const value = String(raw).replaceAll(',', '').trim();
  if (!/^\d+$/.test(value) || !integer(Number(value))) fail('数値が未表示か不正です。読み込み完了後に保存してください。');
  return Number(value);
}
function pointsOf(path) {
  const source = path.replace(/\s+M0,0\s+L0,0\s*$/, '').trim();
  const token = /([ML])\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/g;
  const points = []; let end = 0, match;
  while ((match = token.exec(source))) {
    if (source.slice(end, match.index).trim() || match[1] !== (points.length ? 'L' : 'M')) fail('グラフの線の形式に対応していません。');
    points.push([Number(match[2]), Number(match[3])]); end = token.lastIndex;
  }
  if (source.slice(end).trim() || points.length < 2 || points.length > 50000 ||
      points.some((p, i) => i && p[0] < points[i - 1][0])) fail('グラフの線を読み取れません。');
  return points;
}
function extractGraph(container, kind) {
  if (!container) return null;
  const curves = [...container.querySelectorAll('path')].filter(p => kind === 'daily'
    ? p.classList.contains('amcharts-graph-stroke')
    : p.getAttribute('stroke')?.toLowerCase() === '#f0e448' && p.getAttribute('stroke-width') === '2');
  if (!curves.length) return null;
  if (curves.length !== 1) fail('グラフ線が複数あるため取り込みを止めました。');
  const points = pointsOf(curves[0].getAttribute('d') || '');
  const candidates = [...container.querySelectorAll('path')].filter(p => kind === 'daily'
    ? p.classList.contains('amcharts-axis-zero-grid')
    : p.getAttribute('stroke')?.toLowerCase() === '#ffffff' && p.getAttribute('stroke-width') === '0');
  const zeros = candidates.map(p => pointsOf(p.getAttribute('d') || ''))
    .filter(ps => ps.every(p => p[1] === ps[0][1]) && ps.at(-1)[0] > ps[0][0]);
  if (zeros.length !== 1) fail('グラフのゼロ線を特定できません。');
  // Both chart variants provide the guide and curve in their plot-local coordinates.
  // Validate the starting zero too; unknown chart layouts must not silently shift the line.
  const zeroY = zeros[0][0][1];
  if (Math.abs(points[0][1] - zeroY) > 1) fail('グラフとゼロ線の座標を確認できません。');
  return { kind, zero_y: zeroY, points };
}

export function parsePage(page) {
  const url = siteUrl(page.url), store = storeOf(url);
  // Template content is inert: images, scripts and frames are never attached to the page.
  const template = document.createElement('template');
  template.innerHTML = page.html;
  const dom = template.content;
  const data = emptyData();
  if (url.pathname.endsWith('nc-v03-001.php')) {
    if (url.searchParams.get('cd_ps') !== '2') fail('スロットの機種一覧を保存してください。');
    for (const card of dom.querySelectorAll('#ulKI a.btn-ki')) {
      const link = siteUrl(card.getAttribute('href'), url), rate = link.searchParams.get('bai');
      if (storeOf(link) !== store || link.searchParams.get('cd_ps') !== '2' || !rate) fail('機種リンクを確認できません。');
      const count = text(card.querySelector('.nc-lower')).match(/^(\d+)台$/);
      if (!count) fail('機種の設置台数を確認できません。');
      data.machines.push({ store, rate, machine: text(card.querySelector('.nc-label')), expected_count: Number(count[1]), url: link.href });
    }
    if (!data.machines.length) fail('機種一覧がありません。認証・読み込み完了後に保存してください。');
    return validateData(data);
  }
  const machine = text(dom.querySelector('title')).split('｜').at(-1)?.trim();
  if (!machine || machine.includes('P\'sCUBE')) fail('機種名を特定できません。');
  const machineLink = url.pathname.endsWith('nc-v05-011.php') ? url
    : siteUrl(dom.querySelector('a[href*="nc-v05-011.php"][href*="bai="]')?.getAttribute('href') || '', url);
  const rate = machineLink.searchParams.get('bai');
  if (!rate || storeOf(machineLink) !== store) fail('貸玉を特定できません。');
  data.machines.push({ store, rate, machine, expected_count: null, url: machineLink.href });
  const update = text(dom).match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})\s*更新/);
  const observed_at = update ? `${update[1]}-${update[2]}-${update[3]}T${update[4]}:${update[5]}:00+09:00` : null;
  if (url.pathname.endsWith('nc-v05-011.php')) {
    if (url.searchParams.get('cd_ps') !== '2' && text(dom.querySelector('h1')) !== 'SLOT') fail('スロットのページを保存してください。');
    const selected = dom.querySelectorAll('[data-ymd].selected');
    if (selected.length !== 1) fail('対象営業日を確認できません。');
    const day = dayFromCompact(selected[0].getAttribute('data-ymd'));
    for (const card of dom.querySelectorAll('li[id^="li-"]')) {
      const rack = numberText(card.id.slice(3));
      const rows = Object.fromEntries([...card.querySelectorAll('tr[data-key]')].map(row => [row.dataset.key, text(row.querySelector('td:last-child'))]));
      const link = siteUrl(card.querySelector('a[href*="nc-v06-001.php"]')?.getAttribute('href') || '', url);
      data.records.push({ store, rate, machine, rack, day, observed_at,
        bb: numberText(rows['toku1-count']), rb: numberText(rows['toku5-count']),
        at_art: numberText(rows['toku4-count']), games: numberText(rows.sum_game), my: numberText(rows.sadama_s),
        detail_url: link.href, graph: extractGraph(card.querySelector(`[id="ca-${rack}"]`), 'overview') });
    }
  } else {
    if (text(dom.querySelector('h1')) !== 'SLOT') fail('スロットの台別ページを保存してください。');
    const rack = numberText(url.searchParams.get('cd_dai'));
    const day = dayFromCompact(url.hash.slice(1));
    const heading = text(dom.querySelector('h2')).match(/台番号\s*(\d+)/);
    if (!heading || Number(heading[1]) !== rack) fail('台番号とページの内容が一致しません。');
    const columns = [...dom.querySelectorAll('td.column')];
    if (columns.length !== 7) fail('7日分の表が揃っていません。');
    columns.forEach((column, i) => {
      const values = [...column.querySelectorAll(':scope > div > div')].map(text);
      if (values.length !== 8 || values[0] !== (i ? `${i}日前` : '本日')) fail('日別の表の並びを確認できません。');
      const at = new Date(`${day}T00:00:00Z`); at.setUTCDate(at.getUTCDate() - i);
      const recordDay = at.toISOString().slice(0, 10);
      const link = new URL(url); link.hash = recordDay.replaceAll('-', '');
      data.records.push({ store, rate, machine, rack, day: recordDay, observed_at,
        bb: numberText(values[1]), rb: numberText(values[2]), at_art: numberText(values[3]),
        games: numberText(values[5]), my: numberText(values[6]), detail_url: link.href,
        graph: extractGraph(dom.querySelector(`#svg${i}`), 'daily') });
    });
  }
  if (!data.records.length) fail('台の数値がありません。読み込み完了後に保存してください。');
  return validateData(data);
}

/**
 * 自動取り込み用：表示中のページを今取り込めるか（PC・Androidで共用。仕様：database/PSCUBE_AUTO_CAPTURE.md）。
 * 対象の3種類のページで必要な表示がそろっていれば ready。それ以外（人間確認・同意・読み込み中・
 * 対象外のページ）は理由つきで待つ。ページの操作はしない（読むだけ）。signature は同じページの
 * 二重保存を防ぐための識別（台別ページは日付のhashを含む）。
 */
export function autoPageState(rawUrl, dom) {
  let url;
  try { url = siteUrl(rawUrl); } catch {
    return { ready: false, reason: '対象のページではありません（人間確認・同意の画面なら手動で操作してください）' };
  }
  const has = selector => !!dom.querySelector(selector);
  // 人間確認・約款の同意の画面（hCaptchaの窓、または注意書き）。ここではONのまま待つ。
  const challenge = has('iframe[src*="hcaptcha"]') ||
    /ロボットでないこと|約款に同意して|私は人間です/.test(dom.body?.textContent ?? '');
  if (challenge) return { ready: false, challenge: true, reason: '人間確認・同意の画面（手動で操作してください）' };
  // 対象のページなのに表示がそろわない。続くときはサイトに止められた可能性がある（missing）。
  const wait = reason => ({ ready: false, missing: true, reason });
  const path = url.pathname;
  if (path.endsWith('nc-v03-001.php')) {
    if (url.searchParams.get('cd_ps') !== '2') return { ready: false, reason: 'スロットの機種一覧ではありません' };
    if (!has('#ulKI a.btn-ki')) return wait('機種一覧の表示待ち（人間確認・同意の画面なら手動で操作してください）');
    const identity = new URL(url); identity.hash = '';
    return { ready: true, kind: '機種一覧', signature: identity.href };
  }
  if (path.endsWith('nc-v05-011.php')) {
    if (!has('li[id^="li-"]') || dom.querySelectorAll('[data-ymd].selected').length !== 1) {
      return wait('全台一覧の表示待ち（人間確認・同意の画面なら手動で操作してください）');
    }
    const identity = new URL(url); identity.hash = '';
    return { ready: true, kind: '全台一覧', signature: identity.href };
  }
  if (!/^#\d{8}$/.test(url.hash)) return { ready: false, reason: '台別ページの日付がまだ決まっていません' };
  if (dom.querySelectorAll('td.column').length !== 7) {
    return wait('台別7日分の表示待ち（人間確認・同意の画面なら手動で操作してください）');
  }
  return { ready: true, kind: '台別7日分', signature: url.href };
}

export const suffixEventKey = e => JSON.stringify([e.store, e.rate, e.day]);
export function validateSuffixEvents(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > 100000) fail('末尾イベの印が不正です。');
  const result = raw.map(e => {
    if (!e || typeof e.store !== 'string' || !/^c\d+$/.test(e.store) ||
        typeof e.rate !== 'string' || !/^\d+(?:\.\d+)?$/.test(e.rate) || !validDay(e.day) ||
        typeof e.enabled !== 'boolean' || typeof e.updated_at !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(e.updated_at) ||
        !Number.isFinite(Date.parse(e.updated_at))) fail('末尾イベの印が不正です。');
    return {store:e.store, rate:e.rate, day:e.day, enabled:e.enabled, updated_at:e.updated_at};
  });
  if (new Set(result.map(suffixEventKey)).size !== result.length) fail('末尾イベの印が重複しています。');
  return result;
}

export function validateData(raw) {
  if (raw?.format !== FORMAT || raw.version !== 1 || !Array.isArray(raw.machines) || !Array.isArray(raw.records) || raw.records.length > 100000 || raw.machines.length > 10000) fail('P’s CUBEの保存ファイルではありません。');
  const basic = r => {
    if (!r || !/^c\d+$/.test(r.store) || typeof r.rate !== 'string' || !/^\d+(?:\.\d+)?$/.test(r.rate) ||
        typeof r.machine !== 'string' || !r.machine.trim() || r.machine.length > 200) fail('店舗・貸玉・機種名が不正です。');
    return { store: r.store, rate: r.rate, machine: r.machine.trim() };
  };
  const machines = raw.machines.map(m => {
    const base = basic(m), url = sameStore(m.url, base.store);
    if (!url.pathname.endsWith('nc-v05-011.php') || url.searchParams.get('bai') !== base.rate ||
        (url.searchParams.has('cd_ps') && url.searchParams.get('cd_ps') !== '2') ||
        (m.expected_count !== null && (!integer(m.expected_count) || m.expected_count < 1 || m.expected_count > 5000))) fail('機種情報が不正です。');
    if (m.machine_type != null && !['normal', 'other'].includes(m.machine_type)) fail('機種タイプが不正です。');
    return { ...base, url: url.href, expected_count: m.expected_count, machine_type: m.machine_type ?? null };
  });
  const records = raw.records.map(r => {
    const base = basic(r), url = sameStore(r.detail_url, base.store);
    if (!integer(r.rack) || r.rack < 1 || !validDay(r.day) || !url.pathname.endsWith('nc-v06-001.php') ||
        url.searchParams.get('cd_dai') !== String(r.rack) || url.hash !== `#${r.day.replaceAll('-', '')}`) fail('台番号・営業日・リンクが一致しません。');
    for (const k of ['bb', 'rb', 'at_art', 'games', 'my']) if (!integer(r[k])) fail('台の数値が不正です。');
    if (r.net_medals != null && (!Number.isSafeInteger(r.net_medals) || Math.abs(r.net_medals) > 1000000)) fail('差枚の数値が不正です。');
    let graph = null;
    if (r.graph != null) {
      const g = r.graph;
      if (!['overview', 'daily'].includes(g.kind) || !Number.isFinite(g.zero_y) || !Array.isArray(g.points) || g.points.length < 2 || g.points.length > 50000 ||
          g.points.some((p, i) => !Array.isArray(p) || p.length !== 2 || p.some(v => !Number.isFinite(v) || Math.abs(v) > 1e7) || (i && p[0] < g.points[i - 1][0]))) fail('保存グラフが不正です。');
      graph = { kind: g.kind, zero_y: g.zero_y, points: g.points.map(p => [...p]) };
    }
    if (r.observed_at != null && (typeof r.observed_at !== 'string' || !Number.isFinite(Date.parse(r.observed_at)))) fail('更新時刻が不正です。');
    return { ...base, rack: r.rack, day: r.day, bb: r.bb, rb: r.rb, at_art: r.at_art, games: r.games, my: r.my,
      detail_url: url.href, observed_at: r.observed_at ?? null, graph,
      ...(r.net_medals == null ? {} : {net_medals: r.net_medals}) };
  });
  if (new Set(machines.map(machineKey)).size !== machines.length || new Set(records.map(recordKey)).size !== records.length) fail('同じ機種・台が重複しています。');
  const known = new Set(machines.map(machineKey));
  if (records.some(r => !known.has(machineKey(r)))) fail('台に対応する機種情報がありません。');
  const suffixEvents = validateSuffixEvents(raw.suffix_events);
  return { format: FORMAT, version: 1, machines, records,
    ...(suffixEvents.length ? {suffix_events:suffixEvents} : {}) };
}

export function mergeSuffixEvents(stored = [], incoming = []) {
  const marks = new Map(stored.map(e => [suffixEventKey(e), e]));
  for (const e of incoming) {
    const previous = marks.get(suffixEventKey(e));
    if (!previous || Date.parse(e.updated_at) >= Date.parse(previous.updated_at)) marks.set(suffixEventKey(e), e);
  }
  return [...marks.values()];
}

export function mergeData(stored, incoming) {
  const old = validateData(stored), fresh = validateData(incoming);
  const machines = new Map(old.machines.map(m => [machineKey(m), m]));
  for (const m of fresh.machines) {
    const previous = machines.get(machineKey(m));
    machines.set(machineKey(m), { ...m, expected_count: m.expected_count ?? previous?.expected_count ?? null,
      machine_type: m.machine_type ?? previous?.machine_type ?? null });
  }
  const records = new Map(old.records.map(r => [recordKey(r), r]));
  for (const r of fresh.records) {
    const key = recordKey(r), previous = records.get(key);
    if (!previous) { records.set(key, r); continue; }
    const sameNumbers = ['bb', 'rb', 'at_art', 'games', 'my'].every(k => previous[k] === r[k]);
    const oldTime = Date.parse(previous.observed_at), newTime = Date.parse(r.observed_at);
    const older = Number.isFinite(oldTime) && Number.isFinite(newTime)
      ? newTime < oldTime : r.games < previous.games;
    if (older && !sameNumbers) continue;
    const preferred = older ? previous : r;
    let graph = preferred.graph;
    if (sameNumbers) {
      const alternate = older ? r : previous;
      graph = preferred.graph?.kind === 'daily' ? preferred.graph
        : alternate.graph?.kind === 'daily' ? alternate.graph : preferred.graph ?? alternate.graph;
    }
    const alternate = older ? r : previous;
    records.set(key, { ...preferred, graph,
      ...(sameNumbers && preferred.net_medals == null && alternate.net_medals != null ? {net_medals:alternate.net_medals} : {}) });
  }
  // Marks are independent of machine/rack data. An explicit removal is retained
  // as a dated false value so an older backup cannot bring the mark back.
  return validateData({ ...emptyData(), machines: [...machines.values()], records: [...records.values()],
    suffix_events:mergeSuffixEvents(old.suffix_events, fresh.suffix_events) });
}

/** 沖ドキ（「沖ドキ」「オキドキ」、半角も）は取り込みの対象外（メルヘンと同じ約束）。 */
export const isExcludedMachine = name => /沖ドキ|オキドキ/.test(String(name ?? '').normalize('NFKC'));

/** 当たりが1回もない台（BB・RB・AT/ARTがすべて0、0回転を含む）。台別7日分は取りに行かない（PC・Androidと同じ）。 */
export const noHits = r => r.bb + r.rb + r.at_art === 0;

export function progress(data, machine, day) {
  const records = data.records.filter(r => machineKey(r) === machineKey(machine) && r.day === day).sort((a, b) => a.rack - b.rack);
  const pending = records.filter(r => r.graph?.kind !== 'daily' && !noHits(r));
  return { records, pending, complete: machine.expected_count !== null && records.length === machine.expected_count };
}
