/* Offline PDF Toolbox — pure PDF operations.
   Written so the SAME file runs in the browser (PDFLib global from the
   vendored pdf-lib.min.js) and in Node (require('pdf-lib')) for tests.
   No browser globals are used inside the operations.
*/

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("pdf-lib"));
  } else {
    root.PdfOps = factory(root.PDFLib);
  }
})(typeof self !== "undefined" ? self : this, function (PDFLib) {
  const { PDFDocument, degrees } = PDFLib;

  function isEncryptedError(err) {
    return /encrypt/i.test(String((err && err.message) || ""));
  }

  /** Load a PDF from bytes. Throws Error('not-a-pdf') or
   *  Error('encrypted') for the cases the UI must report. */
  async function loadPdf(bytes) {
    let doc;
    try {
      doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
    } catch (err) {
      if (isEncryptedError(err)) {
        const e = new Error("encrypted");
        e.kind = "encrypted";
        throw e;
      }
      const e = new Error("not-a-pdf");
      e.kind = "not-a-pdf";
      throw e;
    }
    return doc;
  }

  /** Merge several loaded documents into one new document, in order. */
  async function merge(docs) {
    const out = await PDFDocument.create();
    for (const doc of docs) {
      const pages = await out.copyPages(doc, doc.getPageIndices());
      pages.forEach((p) => out.addPage(p));
    }
    return out;
  }

  /** New document with the given pages (0-based indices) of `doc`,
   *  in the given order. */
  async function extract(doc, indices) {
    const out = await PDFDocument.create();
    const pages = await out.copyPages(doc, indices);
    pages.forEach((p) => out.addPage(p));
    return out;
  }

  /** Rotate one page (0-based) of a document by delta degrees. */
  function rotatePage(doc, index, delta) {
    const page = doc.getPage(index);
    const current = page.getRotation().angle;
    page.setRotation(degrees((current + delta + 360) % 360));
  }

  /** Delete pages (0-based indices) from a document. */
  function deletePages(doc, indices) {
    const sorted = [...indices].sort((a, b) => b - a);
    sorted.forEach((i) => doc.removePage(i));
  }

  /** New document with `doc`'s pages in the given order (0-based). */
  async function reorder(doc, order) {
    return extract(doc, order);
  }

  async function save(doc) {
    return doc.save();
  }

  function pageCount(doc) {
    return doc.getPageCount();
  }

  return {
    loadPdf,
    merge,
    extract,
    rotatePage,
    deletePages,
    reorder,
    save,
    pageCount,
  };
});
