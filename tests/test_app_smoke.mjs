/* Offline PDF Toolbox — jsdom smoke test for the app UI.
   Loads app/index.html with its real scripts, feeds it a generated PDF
   through the file input, and drives the real UI: grid, rotate, delete,
   download. Thumbnails cannot render in jsdom (no canvas) — the app must
   degrade to placeholders without breaking, which is itself asserted.
   Run: node --test tests/test_app_smoke.mjs
*/

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(HERE, "..", "app");

async function makePdf(widths) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  widths.forEach((w, i) => {
    const page = doc.addPage([w, 400]);
    page.drawText(`page ${i + 1}`, { x: 20, y: 350, size: 24, font, color: rgb(0, 0, 0) });
  });
  return Buffer.from(await doc.save());
}

async function loadApp() {
  const html = fs.readFileSync(path.join(APP_DIR, "index.html"), "utf8");
  const dom = new JSDOM(html, {
    url: `file://${APP_DIR}/index.html`,
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    beforeParse(window) {
      // jsdom has no IntersectionObserver, no structuredClone and no
      // URL.createObjectURL: stub them (thumbnails cannot render in
      // jsdom anyway; the download path is exercised via the stub URL).
      window.IntersectionObserver = class {
        constructor() {}
        observe() {}
        unobserve() {}
        disconnect() {}
      };
      window.structuredClone = structuredClone;
      window.URL.createObjectURL = () => "blob:test-download";
      window.URL.revokeObjectURL = () => {};
    },
  });
  await new Promise((resolve) => {
    dom.window.addEventListener("load", resolve);
    setTimeout(resolve, 5000);
  });
  return dom;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("load a PDF, see 3 page cards, download builds a PDF", async () => {
  const dom = await loadApp();
  const { document, File } = dom.window;
  const pdfBytes = await makePdf([100, 200, 300]);
  const file = new File([pdfBytes], "test.pdf", { type: "application/pdf" });

  const input = document.getElementById("file-input");
  // jsdom has no DataTransfer: shadow the files property with a plain array
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await sleep(1500);

  assert.equal(document.querySelectorAll("#file-list li").length, 1);
  assert.equal(document.querySelectorAll(".page-card").length, 3);
  assert.match(document.getElementById("counts").textContent, /1 file · 3 pages/);

  // thumbnails cannot render in jsdom: placeholders must show, app alive
  assert.ok(document.querySelector(".thumb-placeholder"));

  // rotate the first page, then delete the second card
  const cards = document.querySelectorAll(".page-card");
  const rotateBtns = cards[0].querySelectorAll(".page-meta button");
  rotateBtns[1].click(); // ↻ rotate right
  await sleep(200);
  assert.equal(document.querySelectorAll(".page-card").length, 3);
  const delBtn = document.querySelectorAll(".page-card")[1]
    .querySelector(".page-delete");
  delBtn.click();
  await sleep(200);
  assert.equal(document.querySelectorAll(".page-card").length, 2);
  assert.match(document.getElementById("counts").textContent, /2 pages/);

  // download the remaining 2 pages
  let clickedHref = null;
  let clickedName = null;
  dom.window.HTMLAnchorElement.prototype.click = function () {
    clickedHref = this.href;
    clickedName = this.download;
  };
  document.getElementById("download").click();
  await sleep(1500);
  assert.ok(clickedHref && clickedHref.startsWith("blob:"));
  assert.equal(clickedName, "test.pdf");
  assert.match(document.getElementById("status").textContent, /Done — downloaded 2 pages/);
  dom.window.close();
});

test("a non-PDF file is rejected with a clear error", async () => {
  const dom = await loadApp();
  const { document, File } = dom.window;
  const file = new File(["hello, not a pdf"], "notes.txt", { type: "text/plain" });
  // bypass the accept filter: call the input path directly
  const input = document.getElementById("file-input");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await sleep(800);
  // .txt is filtered out by the app (only .pdf/.png/.jpg accepted)
  assert.equal(document.querySelectorAll(".page-card").length, 0);
  assert.match(document.getElementById("error").textContent, /PDF, PNG or JPG/);
  dom.window.close();
});
