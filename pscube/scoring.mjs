// P’s CUBEの採点と翌日候補。メルヘンの採点v12（lib/scoring.dart）と翌日候補
// （lib/data_checks.dart）の考え方を、P’s CUBEのデータ（BB/RB・累計G・MY・グラフ）に
// 合わせて移したもの。設計と採用値の理由は database/PSCUBE_SCORING.md。
// 配点・係数は設計上の採用値で、設定や勝率を当てるものではない。
import { machineKey, noHits } from './data.mjs';

export const SCORING_VERSION = 'pscube-2026-10-01-v1';
export const NEXT_DAY_VERSION = 'pscube-2026-10-01-v1';

const SHRINK_GAMES = 1500, SHRINK_DAYS = 3, MIN_REFS = 20;
export const MIN_SCORED_GAMES = 500;
// 出玉のコンプリート上限。メルヘン20スロの記録（19,008枚で打ち止め）から採用した値。
// 貸玉20のときだけ枚数による引き上げに使う（他の貸玉の上限は未確認）。
const COMPLETE_HOLD = 19000, COMPLETE_HOLD_RATE = '20';
const FOCUS_EVIDENCE = 1.96, FOCUS_MAX_SCORE = 88;
const MAX_DAYS = 10, NEXT_SHRINK_DAYS = 5;

// 当たり頻度を使えるのはノーマルタイプだけ（BB/RBの意味が機種で違うため）。
// それ以外は出玉（MY）とグラフの「きれいさ」（終点・維持）で採点する。
export const PROFILES = {
  normal: { hit: 60, hold: 20, end: 10, retention: 10 },
  other: { hit: 0, hold: 50, end: 25, retention: 25 },
};
const NORMAL_WORDS = ['ジャグラー', 'ハナハナ'];

/** 機種のタイプ。画面で設定した値を優先し、未設定なら機種名（ジャグラー・ハナハナ）で決める。 */
export function profileOf(machine) {
  if (machine?.machine_type === 'normal') return 'normal';
  if (machine?.machine_type === 'other') return 'other';
  const name = String(machine?.machine ?? '').normalize('NFKC');
  return NORMAL_WORDS.some(w => name.includes(w)) ? 'normal' : 'other';
}

/** 1日ではあり得ない数値（点検中の88888888など）。採点も比較相手にも使わない。 */
export const implausible = r => r.games > 20000 || r.bb > 500 || r.rb > 500 || r.my > 100000;

const round1 = v => Math.round(v * 10) / 10;
const fixed9 = v => Number(v.toFixed(9));
export function dayShift(day, delta) {
  const t = new Date(`${day}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + delta);
  return t.toISOString().slice(0, 10);
}
export function percentile(value, values) {
  let less = 0, same = 0;
  for (const v of values) { if (v < value) less++; else if (v === value) same++; }
  return (less + 0.5 * same) / values.length;
}

// 機種ごとの仕分け（台の一覧ごとに1回だけ作る）。
const indexCache = new WeakMap();
function byMachine(data) {
  let map = indexCache.get(data.records);
  if (!map) {
    map = new Map();
    for (const r of data.records) {
      const key = machineKey(r);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
    }
    indexCache.set(data.records, map);
  }
  return map;
}
export const machineHistory = (data, record) => byMachine(data).get(machineKey(record)) ?? [];
const machineInfo = (data, record) => data.machines.find(m => machineKey(m) === machineKey(record)) ?? record;

/** 比較相手：同じ店・貸玉・機種で、評価日の30日前〜前日、回転数が近い台。 */
export function comparisonPool(row, data) {
  const first = dayShift(row.day, -30), target = Math.max(500, row.games);
  const lowest = Math.max(500, target / 2), highest = target * 2;
  return machineHistory(data, row).filter(r => r.day >= first && r.day < row.day &&
    r.games >= lowest && r.games <= highest && !implausible(r));
}

function adjustedRank(value, refs, field, maximum, games) {
  if (value == null || !refs.length) return null;
  const n = refs.length, days = new Set(refs.map(r => r.day)).size;
  // 3つの薄さの目安の相乗平均（メルヘンv9以降と同じ）。
  const weight = Math.cbrt(games / (games + SHRINK_GAMES) * n / (n + MIN_REFS) * days / (days + SHRINK_DAYS));
  return maximum * (0.5 + weight * (percentile(value, refs.map(field)) - 0.5));
}

/** 台別ページの7日グラフがあればそれを、なければ一覧のグラフを使う。 */
export const graphOf = r => r.graph ?? null;
export function graphMetrics(graph) {
  if (!graph) return null;
  const ys = graph.points.map(p => p[1]);
  const peakY = Math.min(...ys), endY = ys.at(-1), zero = graph.zero_y;
  if (![peakY, endY, zero].every(Number.isFinite)) return null;
  return { peak: Math.max(0, zero - peakY), end: zero - endY };
}

/** 1台1日の点数。total は評価できないとき null（理由は reasons）。 */
export function scoreRecord(row, data) {
  const machine = machineInfo(data, row), profile = profileOf(machine), weights = PROFILES[profile];
  const base = { profile, weights, parts: null, total: null, provisional: true, coverage: 0, reasons: [] };
  if (row.games <= 0) return { ...base, reasons: ['未稼働・回転数なし'] };
  if (implausible(row)) return { ...base, reasons: ['サイトの数値が異常なため採点なし（88888888などの表示）'] };
  if (row.games <= MIN_SCORED_GAMES) return { ...base, reasons: [`${MIN_SCORED_GAMES}G以下のため採点なし`] };
  const refs = comparisonPool(row, data), reasons = [];
  const days = new Set(refs.map(r => r.day)).size;
  const rate = r => (r.bb + r.rb) / r.games;
  const hit = weights.hit ? adjustedRank(rate(row), refs, rate, weights.hit, row.games) : null;
  const rankedHold = adjustedRank(row.my, refs, r => r.my, weights.hold, row.games);
  const absolute = row.rate === COMPLETE_HOLD_RATE ? weights.hold * Math.min(1, row.my / COMPLETE_HOLD) : null;
  // 枚数による点は、順位による点を引き上げるときだけ使う（下げない）。
  const hold = rankedHold == null ? null : Math.max(rankedHold, absolute ?? 0);
  if (weights.hit && hit == null) reasons.push(`当たり頻度の比較データ不足：中立${weights.hit / 2}点で補完`);
  if (hold == null) reasons.push(`最大放出数の比較データ不足：中立${weights.hold / 2}点で補完`);
  let end = null, retention = null;
  const metrics = graphMetrics(graphOf(row));
  if (!row.graph && noHits(row)) {
    // メルヘンv12と同じ：当たり0回でグラフの無い台は、終点・維持を0点（取った場合とほぼ同じ結果）。
    end = 0; retention = 0;
    reasons.push('当たり0回でグラフ省略：終点・維持は0点');
  } else if (!row.graph) reasons.push(`グラフ未取得：中立${(weights.end + weights.retention) / 2}点で補完`);
  else if (!metrics) reasons.push('グラフ解析保留：中立点で補完');
  else if (metrics.end !== 0 && Math.abs(metrics.end) <= 1) reasons.push('グラフ終点がゼロ線付近：中立点で補完');
  else {
    end = metrics.end > 0 ? weights.end : 0;
    retention = metrics.peak === 0 ? 0 : weights.retention * Math.min(1, Math.max(0, metrics.end / metrics.peak));
    if (end === 0) reasons.push('グラフ終点がゼロ線以下');
  }
  const parts = [['hit', hit, weights.hit], ['hold', hold, weights.hold], ['end', end, weights.end], ['retention', retention, weights.retention]]
    .filter(p => p[2] > 0);
  const missing = parts.filter(p => p[1] == null).reduce((v, p) => v + p[2], 0);
  const observed = parts.reduce((v, p) => v + (p[1] ?? 0), 0);
  const provisional = missing > 0 || row.games < SHRINK_GAMES || refs.length < MIN_REFS || days < SHRINK_DAYS;
  if (provisional) reasons.push('少数データ・欠測を含む暫定評価');
  reasons.push(`比較${refs.length}件/${days}日・観測${row.games}G`);
  if (missing > 0) reasons.push(`評価可能配点${100 - missing}/100・欠測による幅${round1(observed).toFixed(1)}〜${round1(observed + missing).toFixed(1)}（信頼区間ではありません）`);
  return { ...base, parts: { hit, hold, end, retention }, total: round1(observed + missing / 2), provisional,
    coverage: 100 - missing, refs: refs.length, days, reasons };
}

// ---- 翌日候補 ----

// 日ごとの順位に使う値。ノーマルは当たり頻度、それ以外は出玉（MY）。
const dayMetric = profile => profile === 'normal' ? r => (r.bb + r.rb) / r.games : r => r.my;

/** 台ごとの根拠（直近10記録日・30暦日以内の、同じ日の同機種の中での順位）。 */
export function nextDayEvidence(record, data) {
  const profile = profileOf(machineInfo(data, record)), metric = dayMetric(profile);
  const first = dayShift(record.day, -30), byDay = new Map();
  for (const r of machineHistory(data, record)) {
    if (r.day >= first && r.day <= record.day && r.games >= MIN_SCORED_GAMES && !implausible(r)) {
      if (!byDay.has(r.day)) byDay.set(r.day, []);
      byDay.get(r.day).push(r);
    }
  }
  const days = [...byDay].filter(([, rows]) => rows.some(r => r.rack === record.rack)).map(([d]) => d).sort().reverse();
  const contributions = [], gaps = [];
  for (const day of days.slice(0, MAX_DAYS)) {
    const rows = byDay.get(day), mine = rows.find(r => r.rack === record.rack);
    const peers = rows.filter(r => r.games >= mine.games / 2 && r.games <= mine.games * 2);
    if (peers.length < 3) { contributions.push({ day, games: mine.games, peers: peers.length, rank: null, gap: null }); continue; }
    const rank = percentile(metric(mine), peers.map(metric));
    const gap = (100 * rank - 50) * mine.games / (mine.games + SHRINK_GAMES);
    gaps.push(gap); contributions.push({ day, games: mine.games, peers: peers.length, rank, gap });
  }
  const n = gaps.length;
  const rawIndex = n < 3 ? null : 50 + gaps.reduce((a, b) => a + b, 0) / (n + NEXT_SHRINK_DAYS);
  let sum = 0, variance = 0;
  for (const d of contributions) if (d.rank != null) { sum += d.rank - 0.5; variance += (d.peers * d.peers - 1) / (12 * d.peers * d.peers); }
  const today = contributions.find(d => d.day === record.day) ?? null;
  const used = contributions.filter(d => d.gap != null);
  return { record, profile, contributions, rawIndex, index: rawIndex == null ? null : round1(rawIndex),
    usedDays: used.length, latestUsed: used[0]?.day ?? '', today, todayUsed: today?.gap != null,
    // 並びの安定を見る目安。独立・同順位なしを仮定しており、検定の有意性や高設定の確率ではない。
    stabilityZ: variance === 0 ? 0 : sum / Math.sqrt(variance) };
}

export const bandOf = rank => rank == null ? '比較不足' : rank >= 0.75 ? '上' : rank <= 0.25 ? '下' : '中';

export function compareEvidence(a, b) {
  const byIndex = fixed9(b.rawIndex) - fixed9(a.rawIndex);
  if (byIndex) return byIndex;
  if (b.usedDays !== a.usedDays) return b.usedDays - a.usedDays;
  if (b.latestUsed !== a.latestUsed) return a.latestUsed > b.latestUsed ? -1 : 1;
  return a.record.rack - b.record.rack;
}

export function focusReason(e, todayScore) {
  if (todayScore != null && todayScore >= FOCUS_MAX_SCORE) return `当日${todayScore.toFixed(1)}点：${FOCUS_MAX_SCORE}点以上のため★注目から除外`;
  if (!e.todayUsed) return '当日情報が入っていないため★注目の条件未達';
  if (e.stabilityZ < FOCUS_EVIDENCE) return '傾向の安定性基準未達のため★注目の条件未達';
  return `当日情報あり・安定性基準を満たす${todayScore == null ? '（当日点数なし）' : `・当日${FOCUS_MAX_SCORE}点未満`}`;
}
export const qualifiesFocus = (e, todayScore) =>
  e.rawIndex != null && e.todayUsed && e.stabilityZ >= FOCUS_EVIDENCE && (todayScore == null || todayScore < FOCUS_MAX_SCORE);

/**
 * 営業日 [day] の機種 [machine] の翌日候補。判断できた台が4台以上あるときだけ、
 * 上位4分の1（切り上げ）を出す。そのうち当日の情報があり安定している台が★、残りは☆。
 */
export function nextDayCandidates(data, machine, day) {
  const rows = data.records.filter(r => machineKey(r) === machineKey(machine) && r.day === day);
  const evidence = rows.map(r => nextDayEvidence(r, data));
  const eligible = evidence.filter(e => e.rawIndex != null).sort(compareEvidence);
  if (eligible.length < 4) return { total: rows.length, eligible: eligible.length, candidates: [] };
  const count = Math.ceil(eligible.length * 0.25);
  const candidates = eligible.slice(0, count).map(e => {
    const score = scoreRecord(e.record, data).total;
    return { ...e, todayScore: score, focus: qualifiesFocus(e, score), reason: focusReason(e, score) };
  });
  return { total: rows.length, eligible: eligible.length, candidates };
}
