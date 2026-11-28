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

  // A4 and US Letter in PDF points (1/72 inch).
  const PAGE_SIZES = {
    A4: [595.28, 841.89],
    Letter: [612, 792],
    A5: [419.53, 595.28],
  };

  function isEncryptedError(err) {
    return /encrypt/i.test(String((err && err.message) || ""));
  }

  /** Throw a clear RangeError when `indices` has a page the document
   *  does not have. pdf-lib on its own throws a bare TypeError here,
   *  which tells the user nothing. */
  function assertIndices(doc, indices, what) {
    const count = doc.getPageCount();
    indices.forEach((i) => {
      if (!Number.isInteger(i) || i < 0 || i >= count) {
        throw new RangeError(
          `${what}: page ${i + 1} does not exist ` +
          `(document has ${count} page${count === 1 ? "" : "s"})`,
        );
      }
    });
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
    assertIndices(doc, indices, "extract");
    const out = await PDFDocument.create();
    const pages = await out.copyPages(doc, indices);
    pages.forEach((p) => out.addPage(p));
    return out;
  }

  /** Rotate one page (0-based) of a document by delta degrees. */
  function rotatePage(doc, index, delta) {
    assertIndices(doc, [index], "rotate");
    const page = doc.getPage(index);
    const current = page.getRotation().angle;
    page.setRotation(degrees((current + delta + 360) % 360));
  }

  /** Delete pages (0-based indices) from a document. */
  function deletePages(doc, indices) {
    assertIndices(doc, indices, "delete");
    const sorted = [...indices].sort((a, b) => b - a);
    sorted.forEach((i) => doc.removePage(i));
  }

  /** New document with `doc`'s pages in the given order (0-based). */
  async function reorder(doc, order) {
    return extract(doc, order);
  }

  /** Add a blank page of a named size ('A4', 'Letter', 'A5') or an
   *  explicit [width, height] in points. Returns the new page. */
  function addBlankPage(doc, size) {
    const dims = Array.isArray(size)
      ? size
      : (PAGE_SIZES[size] || PAGE_SIZES.A4);
    return doc.addPage(dims);
  }

  /** Add a page holding one image (PNG or JPEG bytes), sized to the
   *  image itself, capped at A4 proportions so a phone photo does not
   *  become a poster-sized page. Returns the new page. */
  async function addImagePage(doc, imageBytes) {
    let image;
    let width;
    let height;
    try {
      image = await doc.embedPng(imageBytes);
    } catch (pngErr) {
      try {
        image = await doc.embedJpg(imageBytes);
      } catch (jpgErr) {
        const e = new Error("not-an-image");
        e.kind = "not-an-image";
        throw e;
      }
    }
    width = image.width;
    height = image.height;
    const maxSide = 1190; // ~A4 long edge in points
    if (width > maxSide || height > maxSide) {
      const scale = maxSide / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    const page = doc.addPage([width, height]);
    page.drawImage(image, { x: 0, y: 0, width, height });
    return page;
  }

  /** Build the output document from the app's page list.
   *  Each item is one of:
   *    { doc, srcIndex, rotation }  — a page copied from a loaded PDF
   *    { blank: true, size }        — a blank page (named size or [w, h])
   *    { imageBytes }               — a page holding one PNG/JPEG image
   *  Items keep their order; consecutive pages from the same source
   *  document are copied in one batch. */
  async function build(items) {
    const out = await PDFDocument.create();
    let i = 0;
    while (i < items.length) {
      const item = items[i];
      if (item.blank) {
        addBlankPage(out, item.size || "A4");
        i += 1;
        continue;
      }
      if (item.imageBytes) {
        const pg = await addImagePage(out, item.imageBytes);
        if (item.rotation) {
          pg.setRotation(degrees(((item.rotation % 360) + 360) % 360));
        }
        i += 1;
        continue;
      }
      // batch consecutive pages from the same document
      const doc = item.doc;
      let j = i;
      const indices = [];
      while (j < items.length && items[j].doc === doc && !items[j].blank &&
             !items[j].imageBytes) {
        indices.push(items[j].srcIndex);
        j += 1;
      }
      assertIndices(doc, indices, "build");
      const copied = await out.copyPages(doc, indices);
      copied.forEach((page, k) => {
        const rot = items[i + k].rotation || 0;
        if (rot) {
          page.setRotation(degrees((page.getRotation().angle + rot) % 360));
        }
        out.addPage(page);
      });
      i = j;
    }
    return out;
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
    addBlankPage,
    addImagePage,
    build,
    save,
    pageCount,
    PAGE_SIZES,
  };
});
