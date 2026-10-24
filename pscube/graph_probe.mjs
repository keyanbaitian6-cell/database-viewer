import {validateData, netMedalsOfProbe} from './data.mjs';
export {netMedalsOfProbe} from './data.mjs';

const fail = message => { throw new Error(message); };

/** 既存記録の台番号と日付にだけ付ける。異なる店舗・貸玉の同番号は推測せず止める。 */
export function applyGraphProbe(existing, raw) {
  const data = validateData(existing), values = netMedalsOfProbe(raw);
  const rack = Number(raw.rack);
  let matched = 0;
  const records = data.records.map(record => {
    if (record.rack !== rack || !values.has(record.day)) return record;
    const matches = data.records.filter(r => r.rack === rack && r.day === record.day);
    if (matches.length !== 1) fail('同じ台番号・日付が複数店舗にあります。店舗を特定できません。');
    matched++;
    return {...record, net_medals: values.get(record.day),net_capture:{version:1,status:'ok',reason:'ok',checked_at:new Date().toISOString()}};
  });
  const compact = String(raw.day);
  const selectedDay = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6)}`;
  if (!matched || !records.some(r => r.rack === rack && r.day === selectedDay)) {
    fail('先にこの台・営業日のP’s CUBE記録を読み込んでください。');
  }
  return validateData({...data, records});
}

/** 保存した元数値だけで再解析する。別台・別日・変わった回転数へ結果を流用しない。 */
export function reanalyseNetCaptures(existing) {
  const data=validateData(existing), records=data.records.map(r=>({...r}));
  const scopes=new Map();
  for (const r of records) {
    const key=JSON.stringify([r.store,r.rate,r.machine,r.rack]);
    if(!scopes.has(key))scopes.set(key,[]);scopes.get(key).push(r);
  }
  let filled=0;
  for (const owner of records.filter(r=>r.net_capture?.probe)) {
    const probe=owner.net_capture.probe;
    let values;try {values=netMedalsOfProbe(probe,{requireSelected:false});}catch {continue;}
    const candidates=scopes.get(JSON.stringify([owner.store,owner.rate,owner.machine,probe.rack])) || [];
    for (const r of candidates) {
      const fingerprint=probe.numbers.find(n=>n.day===r.day);
      if (r.store!==owner.store || r.rate!==owner.rate || r.machine!==owner.machine || r.rack!==probe.rack ||
          r.source_site==='anaslo' || r.net_medals!=null || !values.has(r.day) || !fingerprint ||
          !['bb','rb','at_art','games','my'].every(k=>r[k]===fingerprint[k])) continue;
      r.net_medals=values.get(r.day);filled++;
      r.net_capture={version:1,status:'ok',reason:'ok',checked_at:owner.net_capture.checked_at,
        ...(r===owner ? {probe} : {})};
    }
    if (candidates.filter(r=>probe.numbers.some(n=>n.day===r.day)).every(r=>r.net_medals!=null)) {
      const {probe:unused,...rest}=owner.net_capture;owner.net_capture=rest;
    }
  }
  return {data:validateData({...data,records}),filled,missing:records.filter(r=>r.net_medals==null).length};
}
