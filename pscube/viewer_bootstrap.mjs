import {createPscubeBridge} from './viewer_bridge.mjs';
const bridge = createPscubeBridge();
// 保存の診断（../storage_report.mjs、2026-10-31）。メルヘンの閲覧ページ（index.html）と同じく、読み込み・保存の
// ときに分かった本体の文字数だけを控え、診断のために本体を読み直さない。
let loadedSize = null;
const remember = text => {
  if (typeof text === 'string') loadedSize = {chars: text.length, source: 'pscube'};
  return text;
};
const {load, save} = bridge;
bridge.load = async () => remember(await load());
// 保存に失敗したら、その種類を診断に控える（メルヘンの index.html の save と同じ。保存の動きと失敗はそのまま返す）。
// 2026-11-22：P’s CUBE版にだけ無かった（Geminiの点検 H-8。11/18の記録の「P’s CUBE版も同じに働く」は誤り）。
bridge.save = async text => {
  let result;
  try { result = await save(text); }
  catch (error) {
    try {
      (await import('../storage_report.mjs')).recordSaveFailure({stage: 'write', event: null, name: error?.name,
        message: error?.message, chars: null, hidden: document.visibilityState === 'hidden'});
    } catch (_) { /* 診断を控えられなくても、元の失敗を返す */ }
    throw error;
  }
  remember(text);
  return result;
};
bridge.storageReport = async () => {
  const diag = await import('../storage_report.mjs');
  return JSON.stringify(diag.storageReportLines(await diag.collectStorageReport({loaded: loadedSize})));
};
bridge.phase = async (name, done) => {
  const diag = await import('../storage_report.mjs');
  (done ? diag.phaseFinished : diag.phaseStarted)(name);
};
// 前回のGoogleドライブの更新が途中で終わっていたら、起動時の自動更新を止めている期限（ISO）。無ければ null。
// メルヘン版と同じ6時間の保険（storage_report.mjs の driveHold）。手動の更新ボタンはいつでも使える。
bridge.autoUpdateHold = async () => {
  const diag = await import('../storage_report.mjs');
  return diag.driveHold();
};
window.databaseViewer = bridge;
const script = document.createElement('script');
script.src = 'flutter_bootstrap.js';
script.async = true;
document.body.append(script);
