/* Offline PDF Toolbox — Node tests for app/pdfops.js.
   Run: node --test tests/test_pdfops.mjs  (or: node tests/test_pdfops.mjs)
   Page order is verified through distinct page widths, because pdf-lib
   cannot extract text.
*/

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const PdfOps = require("../app/pdfops.js");

async function makePdf(widths) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  widths.forEach((w, i) => {
    const page = doc.addPage([w, 400]);
    page.drawText(`page ${i + 1}`, {
      x: 20,
      y: 350,
      size: 24,
      font,
      color: rgb(0, 0, 0),
    });
  });
  return doc.save();
}

async function widthsOf(bytes) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => p.getWidth());
}

test("merge keeps order", async () => {
  const a = await PdfOps.loadPdf(await makePdf([100, 200, 300]));
  const b = await PdfOps.loadPdf(await makePdf([400, 500]));
  const out = await PdfOps.merge([a, b]);
  assert.equal(PdfOps.pageCount(out), 5);
  assert.deepEqual(await widthsOf(await PdfOps.save(out)),
    [100, 200, 300, 400, 500]);
});

test("rotate changes rotation angle", async () => {
  const doc = await PdfOps.loadPdf(await makePdf([100, 200]));
  PdfOps.rotatePage(doc, 0, 90);
  assert.equal(doc.getPage(0).getRotation().angle, 90);
  PdfOps.rotatePage(doc, 0, 270);
  assert.equal(doc.getPage(0).getRotation().angle, 0);
});

test("delete removes the right pages", async () => {
  const doc = await PdfOps.loadPdf(await makePdf([100, 200, 300, 400]));
  PdfOps.deletePages(doc, [1, 3]);
  assert.equal(PdfOps.pageCount(doc), 2);
  assert.deepEqual(await widthsOf(await PdfOps.save(doc)), [100, 300]);
});

test("reorder produces the new order", async () => {
  const doc = await PdfOps.loadPdf(await makePdf([100, 200, 300]));
  const out = await PdfOps.reorder(doc, [2, 0, 1]);
  assert.deepEqual(await widthsOf(await PdfOps.save(out)), [300, 100, 200]);
});

test("extract returns only the chosen pages", async () => {
  const doc = await PdfOps.loadPdf(await makePdf([100, 200, 300, 400]));
  const out = await PdfOps.extract(doc, [0, 2]);
  assert.deepEqual(await widthsOf(await PdfOps.save(out)), [100, 300]);
});

test("garbage bytes are rejected as not-a-pdf", async () => {
  await assert.rejects(
    PdfOps.loadPdf(new Uint8Array([1, 2, 3, 4, 5])),
    (err) => err.kind === "not-a-pdf",
  );
});

test("output opens again in pdf-lib (round trip)", async () => {
  const doc = await PdfOps.loadPdf(await makePdf([100, 200]));
  const bytes = await PdfOps.save(doc);
  const reopened = await PdfOps.loadPdf(bytes);
  assert.equal(PdfOps.pageCount(reopened), 2);
});

// ---- v2: validation, blank pages, image pages, build() ------------------

test("extract with an out-of-range page fails with a clear error", async () => {
  const doc = await PdfOps.loadPdf(await makePdf([100, 200]));
  await assert.rejects(
    PdfOps.extract(doc, [0, 5]),
    (err) => err instanceof RangeError && /page 6 does not exist/.test(err.message),
  );
});

test("reorder / rotate / delete reject out-of-range pages clearly", async () => {
  const doc = await PdfOps.loadPdf(await makePdf([100, 200]));
  await assert.rejects(
    PdfOps.reorder(doc, [1, 3]),
    (err) => err instanceof RangeError && /page 4/.test(err.message),
  );
  assert.throws(
    () => PdfOps.rotatePage(doc, 2, 90),
    (err) => err instanceof RangeError && /page 3/.test(err.message),
  );
  assert.throws(
    () => PdfOps.deletePages(doc, [7]),
    (err) => err instanceof RangeError && /page 8/.test(err.message),
  );
});

test("addBlankPage inserts the right sizes", async () => {
  const doc = await PdfOps.loadPdf(await makePdf([100]));
  const a4 = PdfOps.addBlankPage(doc, "A4");
  assert.equal(Math.round(a4.getWidth()), 595);
  assert.equal(Math.round(a4.getHeight()), 842);
  const letter = PdfOps.addBlankPage(doc, "Letter");
  assert.equal(Math.round(letter.getWidth()), 612);
  assert.equal(Math.round(letter.getHeight()), 792);
  assert.equal(PdfOps.pageCount(doc), 3);
});

// a 1x1 red PNG, base64
const RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

test("addImagePage adds a page sized to the image", async () => {
  const doc = await PdfOps.loadPdf(await makePdf([100]));
  await PdfOps.addImagePage(doc, new Uint8Array(RED_PNG));
  assert.equal(PdfOps.pageCount(doc), 2);
  const page = doc.getPage(1);
  assert.equal(page.getWidth(), 1);
  assert.equal(page.getHeight(), 1);
});

test("addImagePage rejects garbage with a clear kind", async () => {
  const doc = await PdfOps.loadPdf(await makePdf([100]));
  await assert.rejects(
    PdfOps.addImagePage(doc, new Uint8Array([1, 2, 3, 4])),
    (err) => err.kind === "not-an-image",
  );
});

test("build composes pdf pages, a blank page and an image, keeping order and rotation", async () => {
  const a = await PdfOps.loadPdf(await makePdf([100, 200]));
  const b = await PdfOps.loadPdf(await makePdf([300]));
  const out = await PdfOps.build([
    { doc: b, srcIndex: 0, rotation: 0 },
    { doc: a, srcIndex: 1, rotation: 90 },
    { blank: true, size: "A4" },
    { imageBytes: new Uint8Array(RED_PNG), rotation: 0 },
    { doc: a, srcIndex: 0, rotation: 0 },
  ]);
  assert.equal(PdfOps.pageCount(out), 5);
  assert.deepEqual(await widthsOf(await PdfOps.save(out)),
    [300, 200, 595.28, 1, 100]);
  assert.equal(out.getPage(1).getRotation().angle, 90);
});

test("build with only selected pages is the split path", async () => {
  const doc = await PdfOps.loadPdf(await makePdf([100, 200, 300]));
  const out = await PdfOps.build([
    { doc, srcIndex: 2, rotation: 0 },
    { doc, srcIndex: 0, rotation: 0 },
  ]);
  assert.deepEqual(await widthsOf(await PdfOps.save(out)), [300, 100]);
});
