import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { ArtifactType, StoredArtifact } from "./store.js";

export const ARTIFACT_VIEWER_RESPONSE_OVERHEAD_BYTES = 128 * 1024;

const require = createRequire(import.meta.url);
const qrCodeBrowserSource = readFileSync(require.resolve("qrcode-generator"), "utf8");

const artifactFrameTitles = {
  archify: "Archify artifact",
  presentation: "Presentation artifact",
  mockup: "Mockup artifact",
} as const satisfies Record<ArtifactType, string>;

export function renderArtifactViewer(artifact: StoredArtifact) {
  const encodedArtifact = artifact.content.toString("base64");
  const frameTitle = artifactFrameTitles[artifact.type as ArtifactType];
  const document = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${frameTitle} viewer</title>
<style>
:root {
  color-scheme: light;
  --viewer-bg: #F2EADE;
  --viewer-surface: #EADFCD;
  --viewer-raised: #E0D2BD;
  --viewer-line: #604939;
  --viewer-field: #F9F6F0;
  --viewer-text: #604939;
  --viewer-muted: #66574D;
  --viewer-link: #3D5D71;
  --viewer-ok: #3D6034;
  --viewer-qr-light: #FFFFFF;
  --viewer-qr-dark: #000000;
}
* { box-sizing: border-box; }
html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
body { background: var(--viewer-bg); color: var(--viewer-text); font: 400 16px/1.45 system-ui, sans-serif; }
.artifact-frame { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; }
.share-dismiss { position: fixed; z-index: 1; inset: 0; background: transparent; }
.share-root { position: fixed; z-index: 2; top: 6px; right: 0; }
.share-tab {
  display: block;
  width: 72px;
  height: 28px;
  border: 1px solid var(--viewer-line);
  border-right: 0;
  border-radius: 8px 0 0 8px;
  box-shadow: 0 0 0 2px var(--viewer-field);
  background: var(--viewer-raised);
  color: var(--viewer-text);
  font: 600 13.5px/1 system-ui, sans-serif;
  cursor: pointer;
}
.share-tab:focus-visible, .share-panel button:focus-visible, .share-panel a:focus-visible, .share-panel input:focus-visible {
  outline: 3px solid var(--viewer-link);
  outline-offset: 2px;
}
.share-panel {
  position: absolute;
  top: 32px;
  right: 8px;
  width: min(288px, calc(100vw - 16px));
  padding: 16px;
  border: 1px solid var(--viewer-line);
  border-radius: 12px;
  background: var(--viewer-surface);
  box-shadow: 0 4px 0 var(--viewer-line);
}
.share-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.share-heading h1 { margin: 0; font-size: 17px; font-weight: 600; }
.share-close { width: 32px; height: 32px; padding: 0; font-size: 22px; line-height: 1; }
.share-qr { display: grid; width: 128px; height: 128px; margin: 12px auto; place-items: center; background: var(--viewer-qr-light); }
.share-qr svg { display: block; width: 128px; height: 128px; }
.share-qr rect { fill: var(--viewer-qr-light); }
.share-qr path { fill: var(--viewer-qr-dark); }
.share-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.share-panel button, .share-panel a {
  min-height: 40px;
  border: 1px solid var(--viewer-line);
  border-radius: 8px;
  background: var(--viewer-field);
  color: var(--viewer-text);
  font: 500 14px/1.2 system-ui, sans-serif;
}
.share-panel button { cursor: pointer; }
.share-panel a { display: grid; place-items: center; text-decoration: underline; text-decoration-thickness: 1px; }
.share-status { min-height: 21px; margin: 10px 0 0; color: var(--viewer-muted); font-size: 13.5px; }
.share-status[data-success="true"] { color: var(--viewer-ok); }
.share-fallback { width: 100%; margin-top: 6px; padding: 8px; border: 1px solid var(--viewer-line); border-radius: 6px; background: var(--viewer-field); color: var(--viewer-text); font: 400 12px/1.3 ui-monospace, monospace; }
[hidden] { display: none !important; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; } }
</style>
</head>
<body data-artifact-viewer>
<iframe class="artifact-frame" data-artifact-frame title="${frameTitle}" sandbox="allow-scripts allow-downloads"></iframe>
<div class="share-dismiss" data-share-dismiss aria-hidden="true" hidden></div>
<aside class="share-root" data-share-root>
  <button class="share-tab" data-share-tab type="button" aria-expanded="false" aria-controls="share-panel">Share</button>
  <section class="share-panel" data-share-panel id="share-panel" aria-label="Share artifact" hidden>
    <div class="share-heading">
      <h1>Share artifact</h1>
      <button class="share-close" data-share-close type="button" aria-label="Close Share panel">&times;</button>
    </div>
    <div class="share-qr" data-share-qr role="img" aria-label="QR code for this artifact"></div>
    <div class="share-actions">
      <button data-copy-link type="button">Copy link</button>
      <a data-download-link href="">Download</a>
    </div>
    <p class="share-status" data-share-status aria-live="polite"></p>
    <input class="share-fallback" data-share-fallback aria-label="Artifact link" readonly hidden>
  </section>
</aside>
<script id="artifact-payload" type="application/octet-stream">${encodedArtifact}</script>
<script>
${qrCodeBrowserSource}
(() => {
  function createArtifactUrl() {
    const payloadElement = document.querySelector('#artifact-payload');
    const binary = atob(payloadElement.textContent.trim());
    payloadElement.textContent = '';
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return URL.createObjectURL(new Blob([bytes], { type: 'text/html;charset=utf-8' }));
  }
  document.querySelector('[data-artifact-frame]').src = createArtifactUrl();

  const canonicalUrl = new URL(location.pathname, location.origin).href;
  const downloadUrl = new URL(location.pathname.replace(/\\/view$/, '/download'), location.origin).href;
  const root = document.querySelector('[data-share-root]');
  const tab = document.querySelector('[data-share-tab]');
  const panel = document.querySelector('[data-share-panel]');
  const dismiss = document.querySelector('[data-share-dismiss]');
  const closeButton = document.querySelector('[data-share-close]');
  const copyButton = document.querySelector('[data-copy-link]');
  const fallback = document.querySelector('[data-share-fallback]');
  const status = document.querySelector('[data-share-status]');
  const download = document.querySelector('[data-download-link]');
  let pinned = false;

  download.href = downloadUrl;
  fallback.value = canonicalUrl;
  const qr = qrcode(0, 'M');
  qr.addData(canonicalUrl, 'Byte');
  qr.make();
  document.querySelector('[data-share-qr]').innerHTML = qr.createSvgTag({ scalable: true, margin: 4 });

  function setOpen(open, returnFocus = false) {
    if (!open && returnFocus) tab.focus();
    panel.hidden = !open;
    dismiss.hidden = !open;
    tab.setAttribute('aria-expanded', String(open));
    if (!open) {
      pinned = false;
      fallback.hidden = true;
      status.textContent = '';
      status.removeAttribute('data-success');
    }
  }

  root.addEventListener('pointerenter', () => setOpen(true));
  root.addEventListener('pointerleave', () => {
    if (!pinned && !root.contains(document.activeElement)) setOpen(false);
  });
  root.addEventListener('focusin', () => setOpen(true));
  root.addEventListener('focusout', () => queueMicrotask(() => {
    if (!pinned && !root.contains(document.activeElement)) setOpen(false);
  }));
  tab.addEventListener('click', () => {
    pinned = true;
    setOpen(true);
  });
  dismiss.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    if (event.pointerType !== 'mouse') setOpen(false, true);
  });
  dismiss.addEventListener('click', () => setOpen(false, true));
  closeButton.addEventListener('click', () => setOpen(false, true));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) {
      event.preventDefault();
      setOpen(false, true);
    }
  });
  copyButton.addEventListener('click', async () => {
    fallback.hidden = true;
    status.removeAttribute('data-success');
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(canonicalUrl);
      status.textContent = 'Link copied.';
      status.dataset.success = 'true';
    } catch {
      status.textContent = 'Copy unavailable. Select the link below.';
      fallback.hidden = false;
      fallback.focus();
      fallback.select();
    }
  });
})();
</script>
</body>
</html>`;

  const response = Buffer.from(document);
  const encodedBytes = 4 * Math.ceil(artifact.content.byteLength / 3);
  if (response.byteLength > encodedBytes + ARTIFACT_VIEWER_RESPONSE_OVERHEAD_BYTES) {
    throw new Error("Artifact viewer response exceeded its documented overhead bound.");
  }
  return response;
}
