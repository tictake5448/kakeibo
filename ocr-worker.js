/* 端末内OCR用ワーカー。tesseract.js-core（Apache-2.0）を直接使う最小構成。 */
'use strict';
let core = null, api = null, curPsm = 6;
const post = (type, extra) => self.postMessage(Object.assign({type}, extra || {}));

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'init') {
      importScripts(m.corePath);
      core = await TesseractCore({
        TesseractProgress: p => post('progress', {value: Math.max(0, Math.min(1, (p - 30) / 70))})
      });
      core.FS.writeFile('jpn.traineddata', new Uint8Array(m.lang));
      api = new core.TessBaseAPI();
      const rc = api.Init(null, 'jpn');
      if (rc !== 0) throw new Error('言語データの読み込みに失敗しました');
      curPsm = m.psm || 6;
      api.SetVariable('tessedit_pageseg_mode', String(curPsm));
      api.SetVariable('preserve_interword_spaces', '1');
      post('ready');
    } else if (m.type === 'recognize') {
      if (m.psm && m.psm !== curPsm) { api.SetVariable('tessedit_pageseg_mode', String(m.psm)); curPsm = m.psm; }
      core.FS.writeFile('/input', new Uint8Array(m.image));
      api.SetImageFile();
      api.Recognize(null);
      const text = api.GetUTF8Text();
      post('result', {text});
    } else if (m.type === 'close') {
      try { api && api.End(); core && core.destroy(api); } catch (e) {}
      post('closed');
    }
  } catch (e) {
    post('error', {message: String(e && e.message || e)});
  }
};
