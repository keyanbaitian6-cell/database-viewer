import {createPscubeBridge} from './viewer_bridge.mjs';
window.databaseViewer = createPscubeBridge();
const script = document.createElement('script');
script.src = 'flutter_bootstrap.js';
script.async = true;
document.body.append(script);
