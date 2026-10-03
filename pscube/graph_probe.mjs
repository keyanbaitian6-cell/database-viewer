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
    return {...record, net_medals: values.get(record.day)};
  });
  const compact = String(raw.day);
  const selectedDay = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6)}`;
  if (!matched || !records.some(r => r.rack === rack && r.day === selectedDay)) {
    fail('先にこの台・営業日のP’s CUBE記録を読み込んでください。');
  }
  return validateData({...data, records});
}
