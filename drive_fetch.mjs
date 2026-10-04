// 閲覧ページ（メルヘン web/index.html・P’s CUBE web/pscube/sync.mjs）のGoogleドライブ読み込みの共通部品。
//
// Apps Script（tool/viewer_drive_script.gs）は、ときどき返事が固まり、30〜90秒たってから404を返す
// （2026-10-04の実測：メルヘン8回中4回。固まるのは1回ごとで、別のリクエストはすぐ通ることが多い）。
// 待ち続けても戻らないので、返事が来ないときは8秒ごとに同じリクエストをもう1本出し、先に成功した方を使う。
// 404・429・5xx・通信失敗はすぐ（少し待って）次を出す。出せるのは、最初の1本と合わせて最大4本。

export const HEDGE_AFTER_MS = 8000;
export const DRIVE_RETRY_DELAYS_MS = [1500, 3000, 3000];
export const isRetryableStatus = status => status === 404 || status === 429 || status >= 500;
export const CHECK_FORMAT = 'drive-check';

const abortError = () => Object.assign(new Error('abort'), { name: 'AbortError' });

/**
 * [url] を取りに行く。成功した応答（または、やり直しても変わらない403などの応答）を返す。
 * 失敗は例外：外から打ち切られたとき AbortError、やり直しを使い切ったとき
 * `{ status }`（最後の404・5xxなど）か `{ network }`（通信失敗）つきの Error。
 * [signal] で打ち切ると、応答の本文を読んでいる途中のものも止まる。
 * [onLaunch] は、リクエストを出すたびに呼ぶ（呼び出し側の「無応答の時間」を数え直すため）。
 */
export function hedgedFetch(url, {
  fetchImpl = fetch, signal, hedgeMs = HEDGE_AFTER_MS, retryDelays = DRIVE_RETRY_DELAYS_MS, onLaunch = () => {},
} = {}) {
  const maxRequests = retryDelays.length + 1;
  return new Promise((resolve, reject) => {
    const controllers = [];
    let started = 0, inflight = 0, settled = false, last = null, hedgeTimer = 0, retryTimer = 0, retryPending = false;
    const settle = action => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      clearTimeout(retryTimer);
      action();
    };
    if (signal?.aborted) { reject(abortError()); return; }
    signal?.addEventListener('abort', () => settle(() => reject(abortError())), { once: true });

    const armHedge = () => {
      clearTimeout(hedgeTimer);
      if (!settled && started < maxRequests) hedgeTimer = setTimeout(launch, hedgeMs);
    };
    const failed = () => {
      if (settled) return;
      if (started < maxRequests) {
        if (retryPending) return;
        retryPending = true;
        clearTimeout(hedgeTimer);
        retryTimer = setTimeout(launch, retryDelays[Math.min(started - 1, retryDelays.length - 1)]);
      } else if (inflight === 0) {
        settle(() => reject(Object.assign(new Error('Google Drive request failed'), last)));
      }
    };
    function launch() {
      retryPending = false;
      if (settled || started >= maxRequests) return;
      const index = started++;
      const controller = new AbortController();
      controllers[index] = controller;
      // 外からの打ち切りは、勝った1本の本文の読み込みにも届くようにする。
      signal?.addEventListener('abort', () => controller.abort(), { once: true });
      inflight++;
      onLaunch(index);
      let request;
      try { request = Promise.resolve(fetchImpl(url, { cache: 'no-store', signal: controller.signal, redirect: 'follow' })); }
      catch (error) { request = Promise.reject(error); }
      request.then(response => {
        inflight--;
        if (settled) return;
        if (response.ok || !isRetryableStatus(response.status)) {
          settle(() => {
            controllers.forEach((other, i) => { if (i !== index) other.abort(); });   // 負けた方は止める
            resolve(response);
          });
        } else { last = { status: response.status }; failed(); }
      }, error => {
        inflight--;
        if (settled) return;
        last = { network: error };
        failed();
      });
      armHedge();
    }
    launch();
  });
}

/**
 * 応答の先頭を見て、その続きも読める本文を返す。{ head: 先頭の文字, stream: 先頭から全部 }
 * 通信の断片は短いこともあるので、先頭が [size] バイトそろうまで（または終わりまで）読んでから見る。
 */
export async function peekBody(response, size = 64) {
  const reader = response.body.getReader();
  const early = [];
  let length = 0, done = false;
  while (length < size) {
    const next = await reader.read();
    if (next.done) { done = true; break; }
    early.push(next.value);
    length += next.value.length;
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const part of early) { joined.set(part, offset); offset += part.length; }
  const head = new TextDecoder().decode(joined.subarray(0, size));
  let sent = false;
  const stream = new ReadableStream({
    async pull(controller) {
      if (!sent) {
        sent = true;
        if (length) { controller.enqueue(joined); return; }
      }
      if (done) { controller.close(); return; }
      const next = await reader.read();
      if (next.done) controller.close(); else controller.enqueue(next.value);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return { head, stream };
}

/**
 * 更新の目印だけを先に確かめる（Apps Scriptに ?check=1 を付ける）。新しいスクリプトは
 * `{"format":"drive-check","version":"…"}` だけを返す → `{ version }`。
 * 古いスクリプトは ?check=1 を知らず、ファイルの全文を返す → その全文を `{ stream, response }` で渡す
 * （もう一度読み直さずに使える）。Googleのエラー画面などは `stream` として渡るので、
 * 呼び出し側が中身を見て知らせる。
 * 失敗は [hedgedFetch] と同じ例外。応答が403などのときは `{ response }` だけを返す。
 */
export async function checkVersion(checkUrl, options) {
  const response = await hedgedFetch(checkUrl, options);
  if (!response.ok) return { response };
  const { head, stream } = await peekBody(response);
  if (head.startsWith(`{"format":"${CHECK_FORMAT}"`)) {
    const doc = JSON.parse(await new Response(stream).text());
    return { version: doc.version == null ? null : String(doc.version), response };
  }
  return { stream, response };
}

/**
 * 「この更新の目印のとき、この書き出し時刻の内容を持っている」の覚え。ブラウザの localStorage
 * （使えなければ覚えない＝毎回確かめる）。[source] は 'meruhen' か 'pscube'。
 */
export function versionStore(source, storage = globalThis.localStorage) {
  const key = `database-viewer-drive-version-${source}`;
  return {
    get() {
      try { const value = JSON.parse(storage.getItem(key)); return value && typeof value === 'object' ? value : null; }
      catch { return null; }
    },
    set(value) { try { storage.setItem(key, JSON.stringify(value)); } catch { /* 覚えられなくても読み込みは成功 */ } },
  };
}

/** 更新の目印と書き出し時刻の両方が、覚えと同じなら読み直さなくてよい。 */
export function isUnchanged(stored, version, known) {
  return !!(stored && version && known && stored.version === version && stored.exported_at === known);
}
