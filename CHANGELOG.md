# Changelog

## 2.0.0 — 2026-11-28

A major release: the five core jobs are the same, but the app around them
is now a proper page editor instead of a minimal demo.

### New
- Undo / redo (Ctrl+Z / Ctrl+Shift+Z, or the buttons) for every content
  change — delete, reorder, rotate, duplicate, add, clear — up to 50 steps.
- Duplicate any page (⧉), and duplicate all ticked pages at once.
- Insert blank pages (A4, Letter, A5) after the active page or at the end.
- Split into files: download every page as its own PDF
  (`name-01.pdf`, `name-02.pdf`, …).
- Images as pages: PNG/JPG files can be dropped in alongside PDFs and
  become pages in the output.
- Batch actions on ticked pages: rotate left/right, duplicate, delete —
  in a selection bar that appears only when something is ticked.
- Select odd / select even pages, and reverse the whole page order.
- Page position badges (#1, #2, …) showing each page's place in the
  downloaded file.
- File sizes in the file list and total size in the top bar; the download
  status reports the output file size.
- Keyboard shortcuts: Ctrl+Z / Ctrl+Shift+Z, Ctrl+A, Delete, R / Shift+R,
  arrow keys to move between pages.
- Thumbnail zoom slider.

### Fixed
- Rotated thumbnails no longer clip: rotation is rendered into the
  thumbnail itself (pdf.js viewport rotation) instead of a CSS rotate.
- Thumbnails render at 2× resolution, sharp on retina screens.
- Dragging a page can now drop it after the last page (drop on a card's
  right half, or on empty grid space); v1 could only insert before a card.
- The drop target is visible while dragging even when pages are already
  loaded (full-window overlay); v1 hid the dropzone once pages existed.
- Adding the same file twice no longer duplicates its pages — it is
  skipped with a message.
- Out-of-range page operations in `pdfops.js` now fail with a clear
  `RangeError` ("page 6 does not exist") instead of a bare TypeError.
- Hidden panels (selection bar, pages toolbar, drag overlay) no longer
  show through: author `display` rules were overriding the `hidden`
  attribute.
- File sizes showed "0 B": pdf.js takes ownership of (detaches) the
  buffer it opens, so the size is now captured before thumbnails load.
- A single file downloaded unchanged now keeps its original filename
  instead of gaining a "-merged" suffix.

### Tests
- Suite grew from 9 to 20 checks: validation errors, blank pages, image
  pages, build composition, undo/redo, duplicate, reverse, odd/even,
  blank + image UI flows, split download, keyboard shortcuts.
- Plus a real-browser end-to-end run (headless Chromium, 16 checks,
  zero console errors).

## 1.0.0 — 2026-11-25

- Merge multiple PDFs, split/extract selected pages, rotate, delete and
  drag-to-reorder pages — all 100% in the browser, zero permissions.
- Visual page thumbnails (lazy-rendered via pdf.js).
- Clear errors for broken files and password-protected PDFs.
- Test suite: 9 checks (PDF operations + full UI smoke test in jsdom).
- Manifest V3, MIT licence.
