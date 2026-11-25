# Offline PDF Toolbox

Merge, split, rotate & reorder PDFs — 100% offline. Your files never leave your computer.

> A browser extension (Chrome / Edge, Manifest V3) that does the everyday PDF jobs — merge, split, rotate, delete and reorder pages — entirely in your browser. No upload, no account, no tracking, no permissions.

![Offline PDF Toolbox](icons/icon128.png)

## Why another PDF tool?

Every popular PDF tool either uploads your files to a server (iLovePDF, Smallpdf) or charges for basic features. This one does neither:

- **100% offline** — files are processed in your browser tab and never sent anywhere.
- **Free, forever** — merge, split, rotate, delete, reorder. No paywall, no account.
- **Zero permissions** — the extension asks for nothing: no access to your browsing, no host permissions.
- **Visual pages** — see every page as a thumbnail and drag it where it belongs.

## Install (load unpacked — Chrome Web Store coming later)

```bash
git clone https://github.com/eslam-tohamy2026/offline-pdf-toolbox.git
cd offline-pdf-toolbox
```

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this folder.
4. Click the extension icon in your toolbar — the toolbox opens in a tab.

## Use it

1. Drop PDF files onto the page (or click **Choose PDF files**).
2. Every page appears as a thumbnail. Drag pages to reorder them.
3. Per page: **↺ / ↻** rotate, **×** delete, **☐** tick to select.
4. **Download** saves all pages in the order shown. Tick some pages first and Download saves only those (that's the split/extract).
5. **Clear all** starts over. Nothing is kept after the tab closes.

## What it does, exactly

| Job | How |
|---|---|
| Merge | Add several PDFs — they join in the order shown |
| Split / extract | Tick pages, then Download — only ticked pages are saved |
| Rotate | ↺ / ↻ on any page, 90° steps |
| Delete | × on any page |
| Reorder | Drag any page thumbnail to a new place |
| Password-protected PDFs | Rejected with a clear message (they cannot be processed offline without the password) |
| Broken / non-PDF files | Rejected with a clear message, nothing crashes |

## Privacy

- No server. No account. No analytics. No tracking.
- The extension requests **zero permissions** (`"permissions": []` in `manifest.json`).
- The shipped code makes no network requests at all — no `fetch`, no `XMLHttpRequest`, no third-party scripts. The only libraries are `pdf-lib` and `pdf.js`, vendored locally in `app/vendor/`.
- Files live only in the tab's memory and are gone when the tab closes.

## Develop & test

```bash
npm install          # dev-only: pdf-lib, pdfjs-dist, jsdom (for tests)
npm test             # 9 checks: PDF operations + full UI smoke test in jsdom
```

The PDF operations in `app/pdfops.js` are written so the same file runs in the browser and in Node — the tests exercise the real code.

## Need a custom tool or a PDF workflow automated?

Hire me on Fiverr: https://www.fiverr.com/eslam_engineer — SolidWorks 3D modelling, PDF/sketch → AutoCAD DWG & DXF, CNC/laser-cut files ready for production, Excel VBA automation.

## Licence

MIT — see [LICENSE](LICENSE). Free for personal and commercial use.
