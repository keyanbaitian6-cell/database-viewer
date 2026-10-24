// 改行の有無に依存せず、台・候補を1件ずつ解析する。画像入りの原文全体を保持しない。
// 外枠には値の代わりにnullを置き、末尾までJSONとして検査してから結果を返す。
// skipRecordValuesは保存済み内容からイベントだけを読む用途。入力ファイルの検査では使わない。
export async function readBackupJson(stream, {known, validate, record = value => value, skipRecordValues = false} = {}) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  const envelope = [], arrays = new Map(), keys = new Set();
  let depth = 0, quoted = false, escaped = false, keyText = null;
  let wantsKey = false, key = null, active = null, pieces = [];
  const item = tail => {
    pieces.push(tail);
    const text = pieces.join('').trim();
    pieces = [];
    if (!text) return;
    // 保存済みJSONからイベントだけを読む場合、台の値は再構築しない。
    const value = active === 'records' && skipRecordValues ? null : JSON.parse(text);
    arrays.get(active).push(active === 'records' ? record(value) : value);
    envelope.push('null');
  };
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      let start = 0;
      for (let i = 0; i < value.length; i++) {
        const char = value[i];
        if (quoted) {
          if (keyText !== null) keyText += char;
          if (escaped) { escaped = false; continue; }
          if (char === '\\') { escaped = true; continue; }
          if (char === '"') {
            quoted = false;
            if (keyText !== null) {
              key = JSON.parse(keyText);
              keyText = null;
              if (keys.has(key)) throw new Error('バックアップ内の項目が重複しています：' + key);
              keys.add(key);
              wantsKey = false;
            }
          }
          continue;
        }
        if (char === '"') {
          quoted = true;
          if (depth === 1 && wantsKey) keyText = '"';
          continue;
        }
        if (active && depth === 2 && (char === ',' || char === ']')) {
          item(value.slice(start, i));
          envelope.push(char);
          start = i + 1;
          if (char === ']') { active = null; depth--; }
          continue;
        }
        if (char === '[' && depth === 1 && ['records', 'candidate_snapshots'].includes(key)) {
          envelope.push(value.slice(start, i + 1));
          start = i + 1;
          active = key;
          arrays.set(key, []);
          if (known && key === 'records') {
            let prefix;
            try { prefix = JSON.parse(envelope.join('') + ']}'); } catch { /* 後ろにある見出しは最後に検査する。 */ }
            if (prefix?.format && prefix.exported_at === known) {
              validate?.(prefix);
              try { await reader.cancel(); } catch { /* 残りは読まない。 */ }
              return {unchanged: true, document: prefix};
            }
          }
          depth++;
          continue;
        }
        if (char === '{' || char === '[') {
          depth++;
          if (depth === 1 && char === '{') wantsKey = true;
        } else if (char === '}' || char === ']') {
          depth--;
        } else if (char === ',' && depth === 1) {
          wantsKey = true; key = null;
        }
      }
      (active ? pieces : envelope).push(value.slice(start));
    }
    const doc = JSON.parse(envelope.join(''));
    validate?.(doc);
    for (const [name, values] of arrays) {
      if (!Array.isArray(doc[name]) || doc[name].length !== values.length || doc[name].some(v => v !== null)) {
        throw new Error('バックアップの配列の形式が不正です。');
      }
      doc[name] = values;
    }
    return {unchanged: !!known && doc.exported_at === known, document: doc};
  } catch (error) {
    try { await reader.cancel(); } catch { /* 元の解析エラーを返す。 */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
}
