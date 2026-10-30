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
bridge.save = async text => { const result = await save(text); remember(text); return result; };
bridge.storageReport = async () => {
  const diag = await import('../storage_report.mjs');
  return JSON.stringify(diag.storageReportLines(await diag.collectStorageReport({loaded: loadedSize})));
};
bridge.phase = async (name, done) => {
  const diag = await import('../storage_report.mjs');
  (done ? diag.phaseFinished : diag.phaseStarted)(name);
};
window.databaseViewer = bridge;
const script = document.createElement('script');
script.src = 'flutter_bootstrap.js';
script.async = true;
document.body.append(script);
