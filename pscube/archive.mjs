// Safari WebArchive (binary/XML plist). Read data only; never execute resources.
const MAX_BYTES = 32 * 1024 * 1024;

export function readBinaryPlist(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 40 || bytes.length > MAX_BYTES ||
      new TextDecoder().decode(bytes.subarray(0, 8)) !== 'bplist00') {
    throw new Error('Webアーカイブの形式を確認してください。');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const uint = (at, size) => {
    if (![1, 2, 4, 8].includes(size) || at < 0 || at + size > bytes.length) throw new Error('壊れたアーカイブです。');
    let n = 0n;
    for (let i = 0; i < size; i++) n = (n << 8n) | BigInt(bytes[at + i]);
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('アーカイブの値が大きすぎます。');
    return Number(n);
  };
  const trailer = bytes.length - 32;
  const offsetSize = bytes[trailer + 6], refSize = bytes[trailer + 7];
  const count = uint(trailer + 8, 8), root = uint(trailer + 16, 8), table = uint(trailer + 24, 8);
  if (count < 1 || count > 200000 || root >= count || table < 8 || table + count * offsetSize > trailer) throw new Error('壊れたアーカイブです。');
  const offsets = Array.from({ length: count }, (_, i) => uint(table + i * offsetSize, offsetSize));
  const cache = new Map(), active = new Set();
  function object(id, depth = 0) {
    if (!Number.isInteger(id) || id < 0 || id >= count || depth > 100 || active.has(id)) throw new Error('アーカイブの参照が不正です。');
    if (cache.has(id)) return cache.get(id);
    active.add(id);
    let at = offsets[id];
    if (at < 8 || at >= table) throw new Error('アーカイブの位置が不正です。');
    const marker = bytes[at++], type = marker >> 4, info = marker & 15;
    const bounded = size => { if (!Number.isSafeInteger(size) || size < 0 || at + size > table) throw new Error('アーカイブが途中で切れています。'); };
    let value;
    if (type === 0) {
      if (![0, 8, 9].includes(info)) throw new Error('未対応のアーカイブ値です。');
      value = info === 0 ? null : info === 9;
    } else if (type === 1 || type === 8) {
      const size = type === 1 ? 2 ** info : info + 1;
      bounded(size); value = uint(at, size);
    } else if (type === 2 || type === 3) {
      const size = type === 3 ? 8 : 2 ** info;
      bounded(size);
      if (size !== 4 && size !== 8) throw new Error('未対応のアーカイブ数値です。');
      value = size === 4 ? view.getFloat32(at) : view.getFloat64(at);
    } else {
      let length = info;
      if (info === 15) {
        bounded(1);
        const sizeMarker = bytes[at++];
        if (sizeMarker >> 4 !== 1) throw new Error('アーカイブの長さが不正です。');
        const size = 2 ** (sizeMarker & 15); bounded(size);
        length = uint(at, size); at += size;
      }
      if (type === 4 || type === 5 || type === 6) {
        const size = length * (type === 6 ? 2 : 1); bounded(size);
        const data = bytes.subarray(at, at + size);
        value = type === 4 ? data : new TextDecoder(type === 6 ? 'utf-16be' : 'utf-8').decode(data);
      } else if (type === 10 || type === 13) {
        if (length > 200000) throw new Error('アーカイブの要素が多すぎます。');
        bounded(length * refSize * (type === 13 ? 2 : 1));
        if (type === 10) value = Array.from({ length }, (_, i) => object(uint(at + i * refSize, refSize), depth + 1));
        else {
          value = Object.create(null);
          for (let i = 0; i < length; i++) {
            const key = object(uint(at + i * refSize, refSize), depth + 1);
            if (typeof key !== 'string') throw new Error('アーカイブのキーが不正です。');
            value[key] = object(uint(at + (length + i) * refSize, refSize), depth + 1);
          }
        }
      } else throw new Error('未対応のWebアーカイブ形式です。');
    }
    cache.set(id, value); active.delete(id); return value;
  }
  return object(root);
}

function readXmlPlist(bytes) {
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml');
  if (doc.querySelector('parsererror') || doc.documentElement.tagName !== 'plist') throw new Error('Webアーカイブを読み取れません。');
  function value(node, depth = 0) {
    if (!node || depth > 100) throw new Error('アーカイブの構造が不正です。');
    const children = [...node.children];
    if (node.tagName === 'dict') {
      if (children.length % 2) throw new Error('アーカイブの辞書が不正です。');
      const result = Object.create(null);
      for (let i = 0; i < children.length; i += 2) {
        if (children[i].tagName !== 'key') throw new Error('アーカイブのキーが不正です。');
        result[children[i].textContent] = value(children[i + 1], depth + 1);
      }
      return result;
    }
    if (node.tagName === 'array') return children.map(x => value(x, depth + 1));
    if (node.tagName === 'data') return Uint8Array.from(atob(node.textContent.replace(/\s/g, '')), c => c.charCodeAt(0));
    if (node.tagName === 'string' || node.tagName === 'date') return node.textContent;
    if (node.tagName === 'true' || node.tagName === 'false') return node.tagName === 'true';
    if (node.tagName === 'integer' || node.tagName === 'real') return Number(node.textContent);
    throw new Error('未対応のアーカイブ値です。');
  }
  return value(doc.documentElement.firstElementChild);
}

export function readWebArchive(input) {
  const bytes = new Uint8Array(input);
  if (bytes.length > MAX_BYTES) throw new Error('ファイルは32MB以下にしてください。');
  const archive = new TextDecoder().decode(bytes.subarray(0, 8)) === 'bplist00'
    ? readBinaryPlist(bytes) : readXmlPlist(bytes);
  const main = archive?.WebMainResource;
  if (!main || !(main.WebResourceData instanceof Uint8Array) ||
      typeof main.WebResourceURL !== 'string' || main.WebResourceMIMEType !== 'text/html') {
    throw new Error('HTMLのWebアーカイブではありません。');
  }
  return {
    url: main.WebResourceURL,
    html: new TextDecoder(main.WebResourceTextEncodingName || 'utf-8').decode(main.WebResourceData),
  };
}
