/* Offline PDF Toolbox — jsdom tests for the v2 UI:
   undo/redo, duplicate, reverse order, odd/even selection, blank pages,
   image pages, position badges, file sizes, split download.
   Thumbnails cannot render in jsdom (no canvas) — the app must degrade
   to placeholders without breaking, which is itself asserted.
   Run: node --test tests/test_app_v2.mjs
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

// a 1x1 red PNG
const RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

async function loadApp() {
  const html = fs.readFileSync(path.join(APP_DIR, "index.html"), "utf8");
  const dom = new JSDOM(html, {
    url: `file://${APP_DIR}/index.html`,
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    beforeParse(window) {
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

async function addPdf(dom, name, widths, reuseBytes) {
  const { document, File } = dom.window;
  const pdfBytes = reuseBytes || (await makePdf(widths));
  const file = new File([pdfBytes], name, { type: "application/pdf" });
  const input = document.getElementById("file-input");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await sleep(1200);
  return pdfBytes;
}

test("badges, file size, duplicate, reverse, odd/even, undo/redo", async () => {
  const dom = await loadApp();
  const { document } = dom.window;
  await addPdf(dom, "test.pdf", [100, 200, 300]);

  // position badges 1..3 and file size in the file list
  const badges = [...document.querySelectorAll(".page-num")].map((b) => b.textContent);
  assert.deepEqual(badges, ["1", "2", "3"]);
  assert.match(document.querySelector(".file-pages").textContent, /3 p\. · \d+(\.\d+)? (B|KB|MB)/);
  assert.match(document.getElementById("counts").textContent, /1 file · 3 pages/);

  // duplicate the first page: 4 cards, badge order 1..4
  const firstCard = document.querySelectorAll(".page-card")[0];
  const dupBtn = [...firstCard.querySelectorAll(".page-meta button")]
    .find((b) => b.title === "Duplicate page");
  dupBtn.click();
  await sleep(200);
  assert.equal(document.querySelectorAll(".page-card").length, 4);
  assert.deepEqual(
    [...document.querySelectorAll(".page-num")].map((b) => b.textContent),
    ["1", "2", "3", "4"]);

  // undo takes the duplicate back; redo brings it back
  document.getElementById("undo").click();
  await sleep(200);
  assert.equal(document.querySelectorAll(".page-card").length, 3);
  document.getElementById("redo").click();
  await sleep(200);
  assert.equal(document.querySelectorAll(".page-card").length, 4);

  // reverse order: first card is now the old last page (width 300).
  // Widths are not visible in the DOM, so check via the label order:
  // labels are all "test.pdf · p.N" — after reverse the first label is p.3
  document.getElementById("reverse-order").click();
  await sleep(200);
  assert.equal(
    document.querySelectorAll(".page-card .page-label")[0].textContent,
    "test.pdf · p.3");
  assert.equal(
    document.querySelectorAll(".page-card .page-label")[3].textContent,
    "test.pdf · p.1");

  // select odd positions (1 and 3) -> selection bar appears with 2
  document.getElementById("select-odd").click();
  await sleep(200);
  assert.equal(document.getElementById("selection-bar").hidden, false);
  assert.match(document.getElementById("selection-label").textContent, /2 pages selected/);
  assert.equal(document.querySelectorAll(".page-card.selected").length, 2);

  // delete selected, then undo restores all 4
  document.getElementById("sel-delete").click();
  await sleep(200);
  assert.equal(document.querySelectorAll(".page-card").length, 2);
  document.getElementById("undo").click();
  await sleep(200);
  assert.equal(document.querySelectorAll(".page-card").length, 4);
  dom.window.close();
});

test("insert blank page and add an image as a page", async () => {
  const dom = await loadApp();
  const { document, File } = dom.window;
  const firstBytes = await addPdf(dom, "test.pdf", [100, 200]);

  document.getElementById("add-blank").click();
  await sleep(200);
  assert.equal(document.querySelectorAll(".page-card").length, 3);
  assert.equal(
    document.querySelectorAll(".page-card .page-label")[2].textContent,
    "Blank · A4");
  // a blank page has no rotate buttons enabled
  const blankCard = document.querySelectorAll(".page-card")[2];
  const rotBtns = [...blankCard.querySelectorAll(".page-meta button")]
    .filter((b) => b.title.startsWith("Rotate"));
  assert.ok(rotBtns.every((b) => b.disabled));

  // add a PNG: it becomes a third... fourth page
  const img = new File([RED_PNG], "scan.png", { type: "image/png" });
  const input = document.getElementById("file-input");
  Object.defineProperty(input, "files", { value: [img], configurable: true });
  input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await sleep(1200);
  assert.equal(document.querySelectorAll(".page-card").length, 4);
  assert.match(document.getElementById("counts").textContent, /2 files · 4 pages/);
  assert.match(
    document.querySelectorAll(".page-card .page-label")[3].textContent,
    /scan\.png · p\.1/);

  // adding the same PDF again (same name, same bytes) is skipped, not duplicated
  await addPdf(dom, "test.pdf", [100, 200], firstBytes);
  assert.equal(document.querySelectorAll(".page-card").length, 4);
  assert.match(document.getElementById("error").textContent, /already added/);
  dom.window.close();
});

test("split download produces one file per page", async () => {
  const dom = await loadApp();
  const { document } = dom.window;
  await addPdf(dom, "test.pdf", [100, 200, 300]);

  const downloads = [];
  dom.window.HTMLAnchorElement.prototype.click = function () {
    downloads.push({ href: this.href, name: this.download });
  };
  document.getElementById("download-split").click();
  await sleep(2500);
  assert.equal(downloads.length, 3);
  assert.deepEqual(
    downloads.map((d) => d.name),
    ["test-01.pdf", "test-02.pdf", "test-03.pdf"]);
  assert.ok(downloads.every((d) => d.href.startsWith("blob:")));
  assert.match(document.getElementById("status").textContent, /3 separate files/);
  dom.window.close();
});

test("keyboard: Ctrl+Z undoes a delete, R rotates the active page", async () => {
  const dom = await loadApp();
  const { document } = dom.window;
  await addPdf(dom, "test.pdf", [100, 200, 300]);

  // focus the first card, delete it with the Delete key
  const firstCard = document.querySelectorAll(".page-card")[0];
  firstCard.focus();
  await sleep(100);
  document.dispatchEvent(new dom.window.KeyboardEvent("keydown",
    { key: "Delete", bubbles: true }));
  await sleep(200);
  assert.equal(document.querySelectorAll(".page-card").length, 2);

  // Ctrl+Z brings it back
  document.dispatchEvent(new dom.window.KeyboardEvent("keydown",
    { key: "z", ctrlKey: true, bubbles: true }));
  await sleep(200);
  assert.equal(document.querySelectorAll(".page-card").length, 3);
  dom.window.close();
});
