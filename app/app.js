/* Offline PDF Toolbox — app logic.
   All PDF work happens in this tab with the vendored pdf-lib (manipulation)
   and pdf.js (thumbnails). Nothing is uploaded anywhere.
*/

(function () {
  "use strict";

  const PdfOps = window.PdfOps;
  const pdfjsLib = window.pdfjsLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";

  const $ = (id) => document.getElementById(id);
  const els = {
    fileInput: $("file-input"),
    fileList: $("file-list"),
    pageGrid: $("page-grid"),
    dropzone: $("dropzone"),
    pagesPanel: document.querySelector(".pages-panel"),
    pagesToolbar: $("pages-toolbar"),
    counts: $("counts"),
    status: $("status"),
    error: $("error"),
    download: $("download"),
    downloadSplit: $("download-split"),
    selectAll: $("select-all"),
    clearSelection: $("clear-selection"),
    clearAll: $("clear-all"),
    undo: $("undo"),
    redo: $("redo"),
    selectionBar: $("selection-bar"),
    selectionLabel: $("selection-label"),
    dragOverlay: $("drag-overlay"),
    zoom: $("zoom"),
  };

  // ---- state -------------------------------------------------------------
  let fileSeq = 0;
  let pageSeq = 0;
  /** files: [{id, name, size, kind: 'pdf'|'image',
   *           doc (PDFLib, pdf only), pdfjsDoc, pageCount}] */
  let files = [];
  /** pages: [{key, kind: 'pdf'|'blank'|'image', fileId, srcIndex,
   *           rotation, selected, thumb, thumbDone, blankSize,
   *           imageBytes, imageName}] */
  let pages = [];
  let activeKey = null;
  let thumbQueue = [];
  let thumbsInFlight = 0;
  const MAX_THUMBS_IN_FLIGHT = 3;
  const THUMB_WIDTH = 320; // rendered pixels; CSS scales it down (sharp on retina)
  const LARGE_FILE_BYTES = 50 * 1024 * 1024;
  const thumbObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        const key = Number(entry.target.dataset.key);
        thumbObserver.unobserve(entry.target);
        queueThumb(key);
      }
    });
  });

  // Undo / redo: snapshots of the page list (+ file list) taken before
  // every change that alters content or order. Selection is not undone.
  const undoStack = [];
  const redoStack = [];
  const MAX_HISTORY = 50;

  function snapshot() {
    return {
      pages: pages.map((p) => ({ ...p })),
      files: [...files],
      activeKey,
    };
  }

  function pushHistory() {
    undoStack.push(snapshot());
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0;
  }

  function restore(state) {
    pages = state.pages.map((p) => ({ ...p }));
    files = [...state.files];
    activeKey = state.activeKey;
    thumbQueue = [];
    thumbsInFlight = 0;
    renderAll();
  }

  function undo() {
    const prev = undoStack.pop();
    if (!prev) return;
    redoStack.push(snapshot());
    restore(prev);
    setStatus("Undone.");
  }

  function redo() {
    const next = redoStack.pop();
    if (!next) return;
    undoStack.push(snapshot());
    restore(next);
    setStatus("Redone.");
  }

  // ---- helpers -----------------------------------------------------------
  function setStatus(msg) {
    els.status.textContent = msg;
  }

  function showError(msg) {
    els.error.textContent = msg;
    window.clearTimeout(showError._t);
    showError._t = window.setTimeout(() => { els.error.textContent = ""; }, 8000);
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function findFile(id) {
    return files.find((f) => f.id === id);
  }

  function totalPages() {
    return pages.length;
  }

  function selectedPages() {
    return pages.filter((p) => p.selected);
  }

  function isPdfName(name) {
    return /\.pdf$/i.test(name);
  }

  function isImageName(name) {
    return /\.(png|jpe?g)$/i.test(name);
  }

  function refreshTopBar() {
    const nFiles = files.length;
    const nPages = totalPages();
    const nSel = selectedPages().length;
    const totalBytes = files.reduce((s, f) => s + (f.size || 0), 0);
    els.counts.textContent = nFiles === 0
      ? "No files yet"
      : `${nFiles} file${nFiles === 1 ? "" : "s"} · ${nPages} page${nPages === 1 ? "" : "s"}` +
        ` · ${formatBytes(totalBytes)}` +
        (nSel > 0 ? ` · ${nSel} selected` : "");
    els.download.disabled = nPages === 0;
    els.download.textContent = nPages === 0
      ? "Download"
      : nSel > 0
        ? `Download selected (${nSel})`
        : `Download (${nPages} page${nPages === 1 ? "" : "s"})`;
    els.downloadSplit.disabled = nPages === 0;
    els.selectAll.disabled = nPages === 0;
    els.clearSelection.disabled = nSel === 0;
    els.clearAll.disabled = nFiles === 0;
    els.undo.disabled = undoStack.length === 0;
    els.redo.disabled = redoStack.length === 0;
    els.pagesPanel.classList.toggle("has-pages", nPages > 0);
    els.pagesToolbar.hidden = nPages === 0;
    els.selectionBar.hidden = nSel === 0;
    if (nSel > 0) {
      els.selectionLabel.textContent =
        `${nSel} page${nSel === 1 ? "" : "s"} selected`;
    }
  }

  // ---- file loading ------------------------------------------------------
  // Thumbnails are best-effort: if pdf.js cannot open the file for
  // previews, the file still loads — pages just show placeholders.
  async function loadThumbDoc(bytes) {
    try {
      return await pdfjsLib.getDocument({ data: bytes }).promise;
    } catch (err) {
      return null;
    }
  }

  async function addFiles(fileList) {
    const incoming = [...fileList].filter(
      (f) => isPdfName(f.name) || isImageName(f.name));
    if (incoming.length === 0) {
      showError("Please add PDF, PNG or JPG files.");
      return;
    }
    let added = 0;
    let addedPages = 0;
    const skipped = [];
    // snapshot BEFORE mutating, so Undo can take the files back out
    const before = snapshot();
    for (const file of incoming) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // pdf.js takes ownership of this buffer when it opens the file
      // for thumbnails (it transfers/detaches it), so remember the
      // size now — bytes.length reads 0 afterwards.
      const byteLength = bytes.length;
      // same name + same size already loaded: almost certainly the
      // same file dropped twice — skip it instead of duplicating pages
      if (files.some((f) => f.name === file.name && f.size === byteLength)) {
        skipped.push(`"${file.name}" is already added`);
        continue;
      }
      try {
        if (isImageName(file.name)) {
          // validate the image decodes before adding it as a page
          const tmp = await window.PDFLib.PDFDocument.create();
          await PdfOps.addImagePage(tmp, bytes);
          const record = {
            id: ++fileSeq,
            name: file.name,
            size: byteLength,
            kind: "image",
            doc: null,
            pdfjsDoc: null,
            pageCount: 1,
          };
          files.push(record);
          pages.push({
            key: ++pageSeq,
            kind: "image",
            fileId: record.id,
            srcIndex: 0,
            rotation: 0,
            selected: false,
            thumb: null,
            thumbDone: false,
            imageBytes: bytes,
            imageName: file.name,
          });
          added += 1;
          addedPages += 1;
        } else {
          const doc = await PdfOps.loadPdf(bytes);
          const count = PdfOps.pageCount(doc);
          if (count === 0) {
            skipped.push(`"${file.name}" has no pages`);
            continue;
          }
          const pdfjsDoc = await loadThumbDoc(bytes);
          const record = {
            id: ++fileSeq,
            name: file.name,
            size: byteLength,
            kind: "pdf",
            doc,
            pdfjsDoc,
            pageCount: count,
          };
          files.push(record);
          for (let i = 0; i < count; i++) {
            pages.push({
              key: ++pageSeq,
              kind: "pdf",
              fileId: record.id,
              srcIndex: i,
              rotation: 0,
              selected: false,
              thumb: null,
              thumbDone: false,
            });
          }
          added += 1;
          addedPages += count;
          if (byteLength > LARGE_FILE_BYTES) {
            setStatus(`"${file.name}" is large (${formatBytes(byteLength)}) — thumbnails may take a moment.`);
          }
        }
      } catch (err) {
        if (err && err.kind === "encrypted") {
          skipped.push(`"${file.name}" is password-protected`);
        } else if (err && err.kind === "not-an-image") {
          skipped.push(`"${file.name}" is not a valid PNG or JPG`);
        } else {
          skipped.push(`"${file.name}" is not a valid PDF`);
        }
      }
    }
    if (added > 0) {
      undoStack.push(before);
      if (undoStack.length > MAX_HISTORY) undoStack.shift();
      redoStack.length = 0;
      setStatus(`Added ${added} file${added === 1 ? "" : "s"} (${addedPages} pages).`);
    }
    if (skipped.length > 0) {
      showError(`Skipped: ${skipped.join("; ")}.`);
    }
    renderAll();
  }

  function removeFile(fileId) {
    const idx = files.findIndex((f) => f.id === fileId);
    if (idx === -1) return;
    pushHistory();
    const name = files[idx].name;
    files.splice(idx, 1);
    pages = pages.filter((p) => p.fileId !== fileId);
    setStatus(`Removed "${name}".`);
    renderAll();
  }

  function clearAll() {
    if (files.length === 0 && pages.length === 0) return;
    pushHistory();
    files.length = 0;
    pages = [];
    activeKey = null;
    setStatus("Ready. Add a PDF to begin.");
    renderAll();
  }

  // ---- page operations ---------------------------------------------------
  function deletePage(key) {
    const idx = pages.findIndex((p) => p.key === key);
    if (idx === -1) return;
    pushHistory();
    pages.splice(idx, 1);
    if (activeKey === key) activeKey = null;
    setStatus(`Deleted a page. ${totalPages()} pages left.`);
    renderAll();
  }

  function deleteSelected() {
    const nSel = selectedPages().length;
    if (nSel === 0) return;
    pushHistory();
    pages = pages.filter((p) => !p.selected);
    activeKey = null;
    setStatus(`Deleted ${nSel} page${nSel === 1 ? "" : "s"}. ${totalPages()} pages left.`);
    renderAll();
  }

  function rotateEntry(entry, delta) {
    if (entry.kind === "blank") return; // a blank page has no rotation
    pushHistory();
    entry.rotation = (entry.rotation + delta + 360) % 360;
    entry.thumb = null;
    entry.thumbDone = false;
    renderGrid();
    refreshTopBar();
  }

  function rotateSelected(delta) {
    const chosen = selectedPages().filter((p) => p.kind !== "blank");
    if (chosen.length === 0) return;
    pushHistory();
    chosen.forEach((p) => {
      p.rotation = (p.rotation + delta + 360) % 360;
      p.thumb = null;
      p.thumbDone = false;
    });
    renderGrid();
    refreshTopBar();
  }

  function duplicateEntry(entry) {
    pushHistory();
    const at = pages.findIndex((p) => p.key === entry.key);
    const copy = { ...entry, key: ++pageSeq, selected: false };
    pages.splice(at + 1, 0, copy);
    setStatus("Duplicated a page.");
    renderAll();
  }

  function duplicateSelected() {
    const chosen = selectedPages();
    if (chosen.length === 0) return;
    pushHistory();
    // insert each copy right after its original, in original order
    const copies = chosen.map((p) => ({ ...p, key: ++pageSeq, selected: false }));
    chosen.forEach((p, i) => {
      const at = pages.findIndex((q) => q.key === p.key);
      pages.splice(at + 1 + i, 0, copies[i]);
    });
    setStatus(`Duplicated ${chosen.length} page${chosen.length === 1 ? "" : "s"}.`);
    renderAll();
  }

  function movePage(draggedKey, beforeKey, after) {
    if (draggedKey === beforeKey) return;
    const from = pages.findIndex((p) => p.key === draggedKey);
    if (from === -1) return;
    pushHistory();
    const [moved] = pages.splice(from, 1);
    let insertAt;
    if (beforeKey === null) {
      insertAt = pages.length; // dropped on empty space: move to the end
    } else {
      insertAt = pages.findIndex((p) => p.key === beforeKey);
      if (insertAt === -1) insertAt = pages.length;
      else if (after) insertAt += 1;
    }
    pages.splice(insertAt, 0, moved);
    renderGrid();
    refreshTopBar();
  }

  function reverseOrder() {
    if (pages.length < 2) return;
    pushHistory();
    pages.reverse();
    setStatus("Page order reversed.");
    renderAll();
  }

  function insertBlank() {
    pushHistory();
    const size = $("blank-size").value || "A4";
    const entry = {
      key: ++pageSeq,
      kind: "blank",
      fileId: null,
      srcIndex: -1,
      rotation: 0,
      selected: false,
      thumb: null,
      thumbDone: true,
      blankSize: size,
    };
    if (activeKey !== null) {
      const at = pages.findIndex((p) => p.key === activeKey);
      pages.splice(at + 1, 0, entry);
    } else {
      pages.push(entry);
    }
    setStatus(`Inserted a blank ${size} page.`);
    renderAll();
  }

  // ---- rendering ---------------------------------------------------------
  function renderAll() {
    renderFileList();
    renderGrid();
    refreshTopBar();
  }

  function renderFileList() {
    els.fileList.innerHTML = "";
    files.forEach((f) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "file-name";
      name.textContent = f.name;
      name.title = f.name;
      const count = document.createElement("span");
      count.className = "file-pages";
      count.textContent = f.kind === "image"
        ? `image · ${formatBytes(f.size)}`
        : `${f.pageCount} p. · ${formatBytes(f.size)}`;
      const btn = document.createElement("button");
      btn.className = "file-remove";
      btn.textContent = "×";
      btn.title = `Remove ${f.name}`;
      btn.setAttribute("aria-label", `Remove ${f.name}`);
      btn.addEventListener("click", () => removeFile(f.id));
      li.append(name, count, btn);
      els.fileList.appendChild(li);
    });
  }

  function renderGrid() {
    els.pageGrid.innerHTML = "";
    pages.forEach((entry, position) => {
      const file = entry.fileId !== null ? findFile(entry.fileId) : null;
      const card = document.createElement("div");
      card.className = "page-card" +
        (entry.selected ? " selected" : "") +
        (entry.key === activeKey ? " active" : "");
      card.draggable = true;
      card.dataset.key = String(entry.key);
      card.tabIndex = 0;
      card.setAttribute("role", "option");
      card.setAttribute("aria-selected", String(entry.selected));
      card.setAttribute("aria-label",
        `Page ${position + 1} of ${pages.length}` +
        (file ? `, ${file.name}, page ${entry.srcIndex + 1}` : ""));

      const badge = document.createElement("span");
      badge.className = "page-num";
      badge.textContent = String(position + 1);
      badge.title = `Position ${position + 1} of ${pages.length} in the output`;
      card.appendChild(badge);

      const thumbBox = document.createElement("div");
      thumbBox.className = "page-thumb";
      thumbBox.dataset.key = String(entry.key);
      if (entry.kind === "blank") {
        const blank = document.createElement("div");
        blank.className = "blank-thumb";
        blank.textContent = `Blank · ${entry.blankSize || "A4"}`;
        thumbBox.appendChild(blank);
      } else if (entry.thumb) {
        const img = document.createElement("img");
        img.src = entry.thumb;
        img.alt = file ? `Page ${entry.srcIndex + 1} of ${file.name}` : "Page";
        thumbBox.appendChild(img);
      } else {
        const ph = document.createElement("span");
        ph.className = "thumb-placeholder";
        ph.textContent = entry.thumbDone ? "No preview" : "Loading preview…";
        thumbBox.appendChild(ph);
        if (!entry.thumbDone) thumbObserver.observe(thumbBox);
      }
      card.appendChild(thumbBox);

      const meta = document.createElement("div");
      meta.className = "page-meta";
      const check = document.createElement("input");
      check.type = "checkbox";
      check.className = "page-check";
      check.checked = entry.selected;
      check.title = "Tick to include in a selection download";
      check.setAttribute("aria-label", `Select page ${position + 1}`);
      check.addEventListener("change", () => {
        entry.selected = check.checked;
        card.classList.toggle("selected", entry.selected);
        card.setAttribute("aria-selected", String(entry.selected));
        refreshTopBar();
      });
      const label = document.createElement("span");
      label.className = "page-label";
      label.textContent = entry.kind === "blank"
        ? `Blank · ${entry.blankSize || "A4"}`
        : `${file ? file.name : ""} · p.${entry.srcIndex + 1}`;
      label.title = label.textContent;
      const rotL = document.createElement("button");
      rotL.textContent = "↺";
      rotL.title = "Rotate left (Shift+R)";
      rotL.setAttribute("aria-label", "Rotate page left");
      rotL.disabled = entry.kind === "blank";
      rotL.addEventListener("click", (ev) => {
        ev.stopPropagation();
        rotateEntry(entry, -90);
      });
      const rotR = document.createElement("button");
      rotR.textContent = "↻";
      rotR.title = "Rotate right (R)";
      rotR.setAttribute("aria-label", "Rotate page right");
      rotR.disabled = entry.kind === "blank";
      rotR.addEventListener("click", (ev) => {
        ev.stopPropagation();
        rotateEntry(entry, 90);
      });
      const dup = document.createElement("button");
      dup.textContent = "⧉";
      dup.title = "Duplicate page";
      dup.setAttribute("aria-label", "Duplicate page");
      dup.addEventListener("click", (ev) => {
        ev.stopPropagation();
        duplicateEntry(entry);
      });
      const del = document.createElement("button");
      del.className = "page-delete";
      del.textContent = "×";
      del.title = "Delete page (Delete)";
      del.setAttribute("aria-label", "Delete page");
      del.addEventListener("click", (ev) => {
        ev.stopPropagation();
        deletePage(entry.key);
      });
      meta.append(check, label, rotL, rotR, dup, del);
      card.appendChild(meta);

      card.addEventListener("click", () => {
        activeKey = entry.key;
        document.querySelectorAll(".page-card.active").forEach((c) =>
          c.classList.remove("active"));
        card.classList.add("active");
      });
      card.addEventListener("focus", () => { activeKey = entry.key; });
      card.addEventListener("dragstart", (ev) => {
        ev.dataTransfer.setData("text/plain", String(entry.key));
        ev.dataTransfer.effectAllowed = "move";
        card.classList.add("dragging");
      });
      card.addEventListener("dragend", () => {
        card.classList.remove("dragging");
        document.querySelectorAll(".page-card.drop-before, .page-card.drop-after")
          .forEach((c) => c.classList.remove("drop-before", "drop-after"));
      });
      card.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "move";
        const rect = card.getBoundingClientRect();
        const after = (ev.clientX - rect.left) > rect.width / 2;
        card.classList.toggle("drop-after", after);
        card.classList.toggle("drop-before", !after);
      });
      card.addEventListener("dragleave", () => {
        card.classList.remove("drop-before", "drop-after");
      });
      card.addEventListener("drop", (ev) => {
        ev.preventDefault();
        const rect = card.getBoundingClientRect();
        const after = (ev.clientX - rect.left) > rect.width / 2;
        card.classList.remove("drop-before", "drop-after");
        const draggedKey = Number(ev.dataTransfer.getData("text/plain"));
        movePage(draggedKey, entry.key, after);
      });
      els.pageGrid.appendChild(card);
    });
  }

  // ---- thumbnails (lazy, via pdf.js) ------------------------------------
  function queueThumb(key) {
    const entry = pages.find((p) => p.key === key);
    if (!entry || entry.thumbDone) return;
    thumbQueue.push(key);
    pumpThumbs();
  }

  async function pumpThumbs() {
    while (thumbsInFlight < MAX_THUMBS_IN_FLIGHT && thumbQueue.length > 0) {
      const key = thumbQueue.shift();
      thumbsInFlight += 1;
      renderThumb(key).finally(() => {
        thumbsInFlight -= 1;
        pumpThumbs();
      });
    }
  }

  async function renderThumb(key) {
    const entry = pages.find((p) => p.key === key);
    if (!entry || entry.thumbDone) return;
    const file = findFile(entry.fileId);
    if (entry.kind === "image") {
      entry.thumb = await imageThumbDataUrl(entry);
      entry.thumbDone = true;
      if (entry.thumb) {
        paintThumb(key, entry, file ? file.name : "");
      } else {
        const ph = els.pageGrid.querySelector(
          `.page-thumb[data-key="${key}"] .thumb-placeholder`);
        if (ph) ph.textContent = "No preview";
      }
      return;
    }
    if (!file || !file.pdfjsDoc) return;
    try {
      const page = await file.pdfjsDoc.getPage(entry.srcIndex + 1);
      const base = page.getViewport({ scale: 1 });
      const scale = THUMB_WIDTH / base.width;
      // rotation goes into the viewport itself, so a rotated page
      // renders upright in its box instead of being clipped by CSS
      const viewport = page.getViewport({ scale, rotation: entry.rotation || 0 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({
        canvasContext: canvas.getContext("2d"),
        viewport,
      }).promise;
      entry.thumb = canvas.toDataURL("image/png");
      entry.thumbDone = true;
      paintThumb(key, entry, file.name);
    } catch (err) {
      entry.thumbDone = true; // do not retry forever
    }
  }

  function paintThumb(key, entry, fileName) {
    const box = els.pageGrid.querySelector(`.page-thumb[data-key="${key}"]`);
    if (!box || !entry.thumb) return;
    box.innerHTML = "";
    const img = document.createElement("img");
    img.src = entry.thumb;
    img.alt = fileName ? `Page ${entry.srcIndex + 1} of ${fileName}` : "Page";
    box.appendChild(img);
  }

  // Image pages: draw the picture onto a canvas with the entry's
  // rotation applied, so the thumbnail matches the output page.
  function imageThumbDataUrl(entry) {
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(new Blob([entry.imageBytes]));
      img.onload = () => {
        URL.revokeObjectURL(url);
        const rot = ((entry.rotation || 0) % 360 + 360) % 360;
        const swap = rot === 90 || rot === 270;
        const w = swap ? img.naturalHeight : img.naturalWidth;
        const h = swap ? img.naturalWidth : img.naturalHeight;
        const scale = Math.min(1, THUMB_WIDTH / w);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        const ctx = canvas.getContext("2d");
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate((rot * Math.PI) / 180);
        ctx.drawImage(img,
          -img.naturalWidth * scale / 2, -img.naturalHeight * scale / 2,
          img.naturalWidth * scale, img.naturalHeight * scale);
        resolve(canvas.toDataURL("image/png"));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    });
  }

  // ---- download ----------------------------------------------------------
  function itemsFor(chosen) {
    return chosen.map((entry) => {
      if (entry.kind === "blank") {
        return { blank: true, size: entry.blankSize || "A4" };
      }
      if (entry.kind === "image") {
        return { imageBytes: entry.imageBytes, rotation: entry.rotation || 0 };
      }
      const file = findFile(entry.fileId);
      return { doc: file.doc, srcIndex: entry.srcIndex, rotation: entry.rotation || 0 };
    });
  }

  function triggerDownload(bytes, filename) {
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
  }

  function baseName() {
    if (files.length === 1) {
      return files[0].name.replace(/\.pdf$/i, "").replace(/\.(png|jpe?g)$/i, "");
    }
    return "merged";
  }

  async function download() {
    const chosen = selectedPages().length > 0 ? selectedPages() : pages;
    if (chosen.length === 0) return;
    els.download.disabled = true;
    setStatus("Building your PDF…");
    try {
      const out = await PdfOps.build(itemsFor(chosen));
      const bytes = await PdfOps.save(out);
      const single = files.length === 1 && chosen.length === totalPages();
      const filename = single
        ? (files[0].kind === "pdf" ? files[0].name : `${baseName()}.pdf`)
        : (selectedPages().length > 0 ? "extracted.pdf" : "merged.pdf");
      triggerDownload(bytes, filename);
      setStatus(`Done — downloaded ${chosen.length} page${chosen.length === 1 ? "" : "s"} (${formatBytes(bytes.length)}).`);
    } catch (err) {
      showError("Something went wrong while building the PDF. Try again.");
    } finally {
      refreshTopBar();
    }
  }

  // One PDF per page, downloaded as separate files. Browsers may ask
  // once whether to allow multiple downloads — that is their setting.
  async function downloadSplit() {
    const chosen = selectedPages().length > 0 ? selectedPages() : pages;
    if (chosen.length === 0) return;
    els.downloadSplit.disabled = true;
    setStatus(`Building ${chosen.length} separate files…`);
    try {
      const base = baseName();
      for (let i = 0; i < chosen.length; i++) {
        const out = await PdfOps.build(itemsFor([chosen[i]]));
        const bytes = await PdfOps.save(out);
        triggerDownload(bytes, `${base}-${String(i + 1).padStart(2, "0")}.pdf`);
        await new Promise((r) => window.setTimeout(r, 250));
      }
      setStatus(`Done — downloaded ${chosen.length} separate file${chosen.length === 1 ? "" : "s"}.`);
    } catch (err) {
      showError("Something went wrong while splitting the PDF. Try again.");
    } finally {
      refreshTopBar();
    }
  }

  // ---- wiring ------------------------------------------------------------
  function openPicker() {
    els.fileInput.click();
  }

  els.fileInput.addEventListener("change", () => {
    if (els.fileInput.files.length > 0) {
      addFiles(els.fileInput.files);
      els.fileInput.value = "";
    }
  });
  $("add-files").addEventListener("click", openPicker);
  $("add-files-big").addEventListener("click", openPicker);
  els.download.addEventListener("click", download);
  els.downloadSplit.addEventListener("click", downloadSplit);
  els.selectAll.addEventListener("click", () => {
    pages.forEach((p) => { p.selected = true; });
    renderGrid();
    refreshTopBar();
  });
  els.clearSelection.addEventListener("click", () => {
    pages.forEach((p) => { p.selected = false; });
    renderGrid();
    refreshTopBar();
  });
  els.clearAll.addEventListener("click", clearAll);
  els.undo.addEventListener("click", undo);
  els.redo.addEventListener("click", redo);
  $("sel-rotate-left").addEventListener("click", () => rotateSelected(-90));
  $("sel-rotate-right").addEventListener("click", () => rotateSelected(90));
  $("sel-duplicate").addEventListener("click", duplicateSelected);
  $("sel-delete").addEventListener("click", deleteSelected);
  $("sel-clear").addEventListener("click", () => {
    pages.forEach((p) => { p.selected = false; });
    renderGrid();
    refreshTopBar();
  });
  $("reverse-order").addEventListener("click", reverseOrder);
  $("add-blank").addEventListener("click", insertBlank);
  $("select-odd").addEventListener("click", () => {
    pages.forEach((p, i) => { p.selected = i % 2 === 0; });
    renderGrid();
    refreshTopBar();
  });
  $("select-even").addEventListener("click", () => {
    pages.forEach((p, i) => { p.selected = i % 2 === 1; });
    renderGrid();
    refreshTopBar();
  });
  els.zoom.addEventListener("input", () => {
    const w = Number(els.zoom.value);
    els.pageGrid.style.setProperty("--thumb-w", `${w}px`);
    els.pageGrid.style.setProperty("--thumb-h", `${Math.round(w * 1.35)}px`);
  });

  function activeEntry() {
    return activeKey !== null
      ? pages.find((p) => p.key === activeKey) || null
      : null;
  }

  function moveActive(delta) {
    if (pages.length === 0) return;
    const idx = pages.findIndex((p) => p.key === activeKey);
    const next = idx === -1
      ? (delta > 0 ? 0 : pages.length - 1)
      : Math.min(pages.length - 1, Math.max(0, idx + delta));
    activeKey = pages[next].key;
    renderGrid();
    const card = els.pageGrid.querySelector(
      `.page-card[data-key="${activeKey}"]`);
    if (card) card.focus();
  }

  document.addEventListener("keydown", (ev) => {
    const target = ev.target;
    const typing = target && (
      target.tagName === "INPUT" || target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT");
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && (ev.key === "z" || ev.key === "Z")) {
      if (typing) return;
      ev.preventDefault();
      if (ev.shiftKey) redo(); else undo();
      return;
    }
    if (mod && (ev.key === "y" || ev.key === "Y")) {
      if (typing) return;
      ev.preventDefault();
      redo();
      return;
    }
    if (mod && (ev.key === "a" || ev.key === "A")) {
      if (typing) return;
      ev.preventDefault();
      pages.forEach((p) => { p.selected = true; });
      renderGrid();
      refreshTopBar();
      return;
    }
    if (typing) return;
    if (ev.key === "Delete" || ev.key === "Backspace") {
      if (selectedPages().length > 0) deleteSelected();
      else if (activeKey !== null) deletePage(activeKey);
    } else if (ev.key === "r" || ev.key === "R") {
      const entry = activeEntry();
      if (selectedPages().length > 0) {
        rotateSelected(ev.shiftKey ? -90 : 90);
      } else if (entry) {
        rotateEntry(entry, ev.shiftKey ? -90 : 90);
      }
    } else if (ev.key === "ArrowRight") {
      ev.preventDefault();
      moveActive(1);
    } else if (ev.key === "ArrowLeft") {
      ev.preventDefault();
      moveActive(-1);
    }
  });

  // drag-and-drop files onto the whole window
  let dragDepth = 0;
  document.addEventListener("dragenter", (ev) => {
    ev.preventDefault();
    dragDepth += 1;
    els.dropzone.classList.add("drag-over");
    els.dragOverlay.hidden = false;
  });
  document.addEventListener("dragleave", (ev) => {
    ev.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      els.dropzone.classList.remove("drag-over");
      els.dragOverlay.hidden = true;
    }
  });
  document.addEventListener("dragover", (ev) => ev.preventDefault());
  document.addEventListener("drop", (ev) => {
    ev.preventDefault();
    dragDepth = 0;
    els.dropzone.classList.remove("drag-over");
    els.dragOverlay.hidden = true;
    if (ev.dataTransfer && ev.dataTransfer.files.length > 0) {
      addFiles(ev.dataTransfer.files);
    }
  });

  // dropping a page on the empty part of the grid moves it to the end
  els.pageGrid.addEventListener("dragover", (ev) => {
    if (ev.target === els.pageGrid) ev.preventDefault();
  });
  els.pageGrid.addEventListener("drop", (ev) => {
    if (ev.target !== els.pageGrid) return;
    ev.preventDefault();
    const draggedKey = Number(ev.dataTransfer.getData("text/plain"));
    movePage(draggedKey, null, false);
  });

  refreshTopBar();
})();
