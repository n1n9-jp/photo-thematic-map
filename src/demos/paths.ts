import { assetUrl } from '../paths';

declare global {
  interface Window {
    /** 確認ページの結果。E2E が読む。 */
    __PATHS_RESULT__?: {
      sampleUrl: string;
      sample: unknown;
      missingUrl: string;
      missingStatus: number;
    };
  }
}

const sampleUrl = assetUrl('data/sample.json');
const missingUrl = assetUrl('data/does-not-exist.json');

const sample: unknown = await (await fetch(sampleUrl)).json();
const missingStatus = (await fetch(missingUrl)).status;

const result = { sampleUrl, sample, missingUrl, missingStatus };
window.__PATHS_RESULT__ = result;

const el = document.getElementById('result');
if (el) el.textContent = JSON.stringify(result, null, 2);

requestAnimationFrame(() => {
  window.__APP_READY__ = true;
});
