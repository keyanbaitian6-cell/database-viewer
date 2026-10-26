export const APPLICATION_RELEASE = '124d21e9dcdb';
// 取得診断には固定の理由と数値だけを残す。認証値・HTML・自由文の応答は保存しない。
export const NET_PROBE_MAX = 64 * 1024;
export const NET_PROBE_BUDGET = 3 * 1024 * 1024;
export const NET_PROBE_DAYS = 7;
const ND_STATUSES = new Set(['ok','empty','invalid','network','unavailable','unknown']);
const ND_REASONS = new Set(['ok','missing_series','empty','short_series','invalid_points','invalid_net','invalid_response','network','not_ready']);
const ND_OMITTED = new Set(['size','unsafe','expired','budget']);
const ND_NUMBERS = ['bb','rb','at_art','games','my'];
const ndError = () => { throw new Error('差枚の取得診断が不正です。'); };
const ndDay = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10) === s;
const ndScalar = v => v == null || (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e12) ||
  (typeof v === 'string' && v.length <= 32 && /^[-+\d.eE]*$/.test(v));

function ndProbe(raw) {
  if (!raw || raw.version !== 1 || !Number.isSafeInteger(raw.rack) || raw.rack < 1 ||
      typeof raw.day !== 'string' || !/^\d{8}$/.test(raw.day) || !ndDay(`${raw.day.slice(0,4)}-${raw.day.slice(4,6)}-${raw.day.slice(6)}`) ||
      !Array.isArray(raw.numbers) || raw.numbers.length < 1 || raw.numbers.length > 7 ||
      !Array.isArray(raw.graph?.datas?.g) || raw.graph.datas.g.length > 7 ||
      !Array.isArray(raw.graph.datas.p) || raw.graph.datas.p.length > 50000 ||
      !ndScalar(raw.graph.anjYUnit ?? 1)) ndError();
  const numbers = raw.numbers.map(r => {
    if (!r || !ndDay(r.day) || ND_NUMBERS.some(k => !Number.isSafeInteger(r[k]) || r[k] < 0)) ndError();
    return {day:r.day,...Object.fromEntries(ND_NUMBERS.map(k => [k,r[k]]))};
  });
  const fields = new Set();
  const g = raw.graph.datas.g.map(line => {
    if (!line || !ndScalar(line.YMD_biz) || !/^\d{8}$/.test(String(line.YMD_biz)) ||
        !/^out-\d{1,5}$/.test(line.xField ?? '') || !/^value-\d{1,5}$/.test(line.yField ?? '')) ndError();
    fields.add(line.xField); fields.add(line.yField);
    return {YMD_biz:line.YMD_biz,xField:line.xField,yField:line.yField};
  });
  const p = raw.graph.datas.p.map(point => {
    if (!point || typeof point !== 'object' || Array.isArray(point)) ndError();
    return Object.fromEntries([...fields].filter(k => Object.hasOwn(point,k)).map(k => {
      if (!ndScalar(point[k])) ndError();
      return [k,point[k]];
    }));
  });
  const probe = {version:1,rack:raw.rack,day:raw.day,numbers,graph:{anjYUnit:raw.graph.anjYUnit ?? 1,datas:{g,p}}};
  if (JSON.stringify(probe).length > NET_PROBE_MAX) throw new Error('診断用の元数値が上限を超えています。');
  return probe;
}

export function makeNetProbe(raw, records) {
  try {
    if (Array.isArray(raw?.graph?.datas?.p) && !raw.graph.datas.p.length) return {};
    const probe=ndProbe({version:1,...raw,numbers:records.map(r => ({day:r.day,
      ...Object.fromEntries(ND_NUMBERS.map(k => [k,r[k]]))}))});
    // 他言語のJSON数値表記に少し余裕を残す。受け側の上限は64KiB。
    return JSON.stringify(probe).length>60*1024 ? {probe_omitted:"size"} : {probe};
  } catch (error) {
    return {probe_omitted:error.message.includes('上限') ? 'size' : 'unsafe'};
  }
}

export function validateNetCapture(value) {
  if (value == null) return null;
  if (value.version !== 1 || !ND_STATUSES.has(value.status) || !ND_REASONS.has(value.reason) ||
      typeof value.checked_at !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value.checked_at) ||
      !Number.isFinite(Date.parse(value.checked_at))) ndError();
  const result = {version:1,status:value.status,reason:value.reason,checked_at:value.checked_at};
  if (value.http_status != null) {
    if (!Number.isSafeInteger(value.http_status) || value.http_status < 0 || value.http_status > 599) ndError();
    result.http_status = value.http_status;
  }
  if (value.probe_omitted != null) {
    if (!ND_OMITTED.has(value.probe_omitted)) ndError();
    result.probe_omitted = value.probe_omitted;
  }
  if (value.probe != null) result.probe = ndProbe(value.probe);
  if (value.probe_available != null) {
    if (typeof value.probe_available !== 'boolean') ndError();
    result.probe_available=value.probe_available;
  }
  return result;
}

export function trimNetProbes(records, now = Date.now()) {
  let remaining = NET_PROBE_BUDGET;
  const samples = records.filter(r => r.net_capture?.probe)
    .sort((a,b) => Date.parse(b.net_capture.checked_at)-Date.parse(a.net_capture.checked_at));
  for (const r of samples) {
    const at = Date.parse(r.net_capture.checked_at), size = JSON.stringify(r.net_capture.probe).length;
    const omitted = at < now-NET_PROBE_DAYS*86400000 || at > now+300000 ? 'expired' : size > remaining ? 'budget' : null;
    if (omitted) {
      const {probe,...rest} = r.net_capture;
      delete rest.probe_available;
      r.net_capture = {...rest,probe_omitted:omitted};
    } else remaining -= size;
  }
  return records;
}

export function mergeNetCapture(chosen, alternate, sameNumbers) {
  if (!sameNumbers) return chosen.net_capture;
  const a = chosen.net_capture, b = alternate.net_capture;
  return !a || (b && (Date.parse(b.checked_at) > Date.parse(a.checked_at) ||
    (b.checked_at===a.checked_at && b.probe && !a.probe))) ? b : a;
}

export function viewerNetCapture(value) {
  const cap=validateNetCapture(value);if(!cap)return null;
  const {probe,probe_available,...rest}=cap;
  return {...rest,...((probe || probe_available!=null) ? {probe_available:!!probe || probe_available===true} : {})};
}

export function netCaptureLabel(record) {
  if (Number.isSafeInteger(record.net_medals)) return record.net_medals === 0 ? '取得済み（0枚）' : '取得済み';
  if (record.source_site === 'anaslo') return '出典に差枚なし';
  const reason = record.net_capture?.reason;
  return ({missing_series:'日別の系列なし',empty:'元数値が空',short_series:'元数値の点が不足',
    invalid_points:'元数値の形式不正',invalid_net:'差枚の範囲不正',invalid_response:'応答の形式不正',
    network:'差枚の通信失敗',not_ready:'サイトの通信準備前'})[reason] || '未取得（理由未記録）';
}

export function netHealth(records) {
  const known = records.filter(r => Number.isSafeInteger(r.net_medals));
  return {total:records.length,known:known.length,zero:known.filter(r => r.net_medals===0).length,
    missing:records.filter(r => !Number.isSafeInteger(r.net_medals)).map(r =>
      ({rack:r.rack,day:r.day,machine:r.machine,reason:netCaptureLabel(r),
        checked_at:r.net_capture?.checked_at ?? null,replayable:!!(r.net_capture?.probe || r.net_capture?.probe_available) &&
          Date.parse(r.net_capture.checked_at)>=Date.now()-NET_PROBE_DAYS*86400000 && Date.parse(r.net_capture.checked_at)<=Date.now()+300000}))};
}

const ndTime = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const ndMillis = value => {const n=Date.parse(value || '');return Number.isFinite(n) ? n : -Infinity;};
export function validateSyncStatus(raw) {
  if (raw == null) return null;
  if (raw.version !== 1 || !Array.isArray(raw.writes) || raw.writes.length > 3) throw new Error('更新状況の形式が不正です。');
  const writes = raw.writes.map(w => {
    if (!w || !['pc','android','browser'].includes(w.source) || !ndTime(w.at) ||
        !Array.isArray(w.stores) || w.stores.length > 100 || (w.drive_at != null && !ndTime(w.drive_at))) throw new Error('更新状況の形式が不正です。');
    return {source:w.source,at:w.at,...(w.drive_at ? {drive_at:w.drive_at} : {}),stores:w.stores.map(s => {
      if (!s || !/^[A-Za-z0-9_-]{1,80}$/.test(s.store ?? '') ||
          (s.rate != null && !/^\d+(?:\.\d+)?$/.test(s.rate)) || !ndDay(s.day) ||
          !Number.isSafeInteger(s.count) || s.count < 0) throw new Error('更新状況の店舗情報が不正です。');
      return {store:s.store,...(s.rate != null ? {rate:s.rate} : {}),day:s.day,count:s.count};
    })};
  });
  if (new Set(writes.map(w => w.source)).size !== writes.length || (raw.processed_at != null && !ndTime(raw.processed_at))) throw new Error('更新状況の形式が不正です。');
  const result={version:1,writes,...(typeof raw.processor_release==='string'&&/^[a-f0-9]{12}$/.test(raw.processor_release)?{processor_release:raw.processor_release}:{}),...(raw.processed_at ? {processed_at:raw.processed_at} : {})};
  for (const key of ['pending','failed_inputs']) if (raw[key]!=null) {
    if (!Number.isSafeInteger(raw[key]) || raw[key]<0 || raw[key]>1000000) throw new Error('更新状況の形式が不正です。');
    result[key]=raw[key];
  }
  if (raw.supplement!=null) {
    const s=raw.supplement;
    if (!ndTime(s.at) || ['applied','unmatched','mismatched','known'].some(k=>!Number.isSafeInteger(s[k]) || s[k]<0 || s[k]>1000000)) throw new Error('補完結果の形式が不正です。');
    result.supplement={at:s.at,...Object.fromEntries(['applied','unmatched','mismatched','known'].map(k=>[k,s[k]]))};
  }
  if (raw.supplement_supported!=null) {
    if (typeof raw.supplement_supported!=='boolean') throw new Error('更新状況の形式が不正です。');
    result.supplement_supported=raw.supplement_supported;
  }
  return result;
}

export function makeSyncWrite(source, at, records, driveAt) {
  if (['pc-viewer','pc-deleted'].includes(source)) source='pc';
  if (!['pc','android','browser'].includes(source) || !ndTime(at)) return null;
  const stores = new Map();
  for (const r of records) {
    const store=r.store || 'nagamachiminami';
    if (!ndDay(r.day) || !/^[A-Za-z0-9_-]{1,80}$/.test(store)) continue;
    const key=JSON.stringify([store,r.rate ?? null]), old=stores.get(key);
    if (!old) stores.set(key,{store,...(r.rate != null ? {rate:r.rate} : {}),day:r.day,count:1});
    else if(r.day>old.day) {old.day=r.day;old.count=1;}
    else if(r.day===old.day) old.count++;
  }
  return validateSyncStatus({version:1,writes:[{source,at,...(ndTime(driveAt) ? {drive_at:driveAt} : {}),stores:[...stores.values()]}]});
}

export function updateStatusLines(status, {exportedAt,loadedAt,checkedAt} = {}) {
  const value=validateSyncStatus(status);
  const when=s=>ndTime(s) ? new Date(s).toLocaleString('ja-JP') : '未確認';
  const storeName=s=>({nagamachiminami:'長町南',saiwaichou:'幸町'})[s.store] || `${/^c\d+$/.test(s.store) ? 'P’s CUBE' : s.store}${s.rate==null ? '' : '（'+s.rate+'スロ）'}`;
  const lines=(value?.writes || []).flatMap(w=>[
    `${({pc:'PC',android:'Android',browser:'iPhone・ブラウザ'})[w.source]}の書き出し：${when(w.at)}／Driveファイルの更新：${when(w.drive_at)}`,
    ...w.stores.map(s=>`この出力の最新日：${storeName(s)} ${s.day}・${s.count}台`)]);
  if (!lines.length) lines.push('元ファイルの書き出し：未確認');
  lines.push(`このページの版：${APPLICATION_RELEASE}`,`Google処理の版：${value?.processor_release || '未確認'}`);
  lines.push(`Google側の処理：${when(value?.processed_at)}`);
  if (value?.pending || value?.failed_inputs) lines.push(`Google側の処理待ち ${value.pending || 0}件・入力失敗 ${value.failed_inputs || 0}件`);
  lines.push(`閲覧データの書き出し：${when(exportedAt)}`,`この端末の読み込み：${when(loadedAt)}`);
  if (checkedAt) lines.push(`この端末で最新か確認：${when(checkedAt)}`);
  if (value?.supplement) {
    const s=value.supplement;
    lines.push(`スマホ補完：反映 ${s.applied}件・取得済み ${s.known}件・数値不一致 ${s.mismatched}件・元記録なし ${s.unmatched}件（${when(s.at)}）`);
  }
  return lines;
}

export function mergeSyncStatus(...items) {
  const writes = new Map(); let processed_at,meta={},supplement;
  for (const item of items) {
    const status=validateSyncStatus(item);if(!status)continue;
    for (const w of status.writes) {
      const old=writes.get(w.source);
      if (!old || Date.parse(w.at)>Date.parse(old.at) || (Date.parse(w.at)===Date.parse(old.at) &&
          ndMillis(w.drive_at)>ndMillis(old.drive_at))) writes.set(w.source,w);
    }
    if (status.processed_at && (!processed_at || Date.parse(status.processed_at)>=Date.parse(processed_at))) {
      processed_at=status.processed_at;
      meta=Object.fromEntries(['pending','failed_inputs','supplement_supported','processor_release'].filter(k=>status[k]!=null).map(k=>[k,status[k]]));
    }
    if (status.supplement && (!supplement || Date.parse(status.supplement.at)>=Date.parse(supplement.at))) supplement=status.supplement;
  }
  return writes.size || processed_at || supplement ? {version:1,writes:[...writes.values()],...(processed_at ? {processed_at,...meta} : {}),...(supplement ? {supplement} : {})} : null;
}
