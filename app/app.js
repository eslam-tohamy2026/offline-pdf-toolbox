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
    counts: $("counts"),
    status: $("status"),
    error: $("error"),
    download: $("download"),
    selectAll: $("select-all"),
    clearSelection: $("clear-selection"),
    clearAll: $("clear-all"),
  };

  // ---- state -------------------------------------------------------------
  let fileSeq = 0;
  let pageSeq = 0;
  /** files: [{id, name, bytes, doc (PDFLib), pdfjsDoc, pageCount}] */
  const files = [];
  /** pages: [{key, fileId, srcIndex, rotation, selected, thumb, thumbDone}] */
  let pages = [];
  let activeKey = null;
  let thumbQueue = [];
  let thumbsInFlight = 0;
  const MAX_THUMBS_IN_FLIGHT = 3;
  const thumbObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        const key = Number(entry.target.dataset.key);
        thumbObserver.unobserve(entry.target);
        queueThumb(key);
      }
    });
  });

  // ---- helpers -----------------------------------------------------------
  function setStatus(msg) {
    els.status.textContent = msg;
  }

  function showError(msg) {
    els.error.textContent = msg;
    window.clearTimeout(showError._t);
    showError._t = window.setTimeout(() => { els.error.textContent = ""; }, 6000);
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

  function refreshTopBar() {
    const nFiles = files.length;
    const nPages = totalPages();
    const nSel = selectedPages().length;
    els.counts.textContent = nFiles === 0
      ? "No files yet"
      : `${nFiles} file${nFiles === 1 ? "" : "s"} · ${nPages} page${nPages === 1 ? "" : "s"}` +
        (nSel > 0 ? ` · ${nSel} selected` : "");
    els.download.disabled = nPages === 0;
    els.download.textContent = nSel > 0
      ? `Download selected (${nSel})`
      : `Download (${nPages} page${nPages === 1 ? "" : "s"})`;
    els.selectAll.disabled = nPages === 0;
    els.clearSelection.disabled = nSel === 0;
    els.clearAll.disabled = nFiles === 0;
    els.pagesPanel.classList.toggle("has-pages", nPages > 0);
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
    const incoming = [...fileList].filter((f) => /\.pdf$/i.test(f.name));
    if (incoming.length === 0) {
      showError("Please add PDF files.");
      return;
    }
    let added = 0;
    let addedPages = 0;
    for (const file of incoming) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const doc = await PdfOps.loadPdf(bytes);
        const count = PdfOps.pageCount(doc);
        if (count === 0) {
          showError(`"${file.name}" has no pages and was skipped.`);
          continue;
        }
        const pdfjsDoc = await loadThumbDoc(bytes);
        const record = {
          id: ++fileSeq,
          name: file.name,
          bytes,
          doc,
          pdfjsDoc,
          pageCount: count,
        };
        files.push(record);
        for (let i = 0; i < count; i++) {
          pages.push({
            key: ++pageSeq,
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
      } catch (err) {
        if (err && err.kind === "encrypted") {
          showError(`"${file.name}" is password-protected and was skipped.`);
        } else {
          showError(`"${file.name}" is not a valid PDF and was skipped.`);
        }
      }
    }
    if (added > 0) {
      setStatus(`Added ${added} file${added === 1 ? "" : "s"} (${addedPages} pages).`);
    }
    renderAll();
  }

  function removeFile(fileId) {
    const idx = files.findIndex((f) => f.id === fileId);
    if (idx === -1) return;
    const name = files[idx].name;
    files.splice(idx, 1);
    pages = pages.filter((p) => p.fileId !== fileId);
    setStatus(`Removed "${name}".`);
    renderAll();
  }

  function clearAll() {
    files.length = 0;
    pages = [];
    activeKey = null;
    setStatus("Ready. Add a PDF to begin.");
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
      count.textContent = `${f.pageCount} p.`;
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
    pages.forEach((entry) => {
      const file = findFile(entry.fileId);
      const card = document.createElement("div");
      card.className = "page-card" +
        (entry.selected ? " selected" : "") +
        (entry.key === activeKey ? " active" : "");
      card.draggable = true;
      card.dataset.key = String(entry.key);

      const thumbBox = document.createElement("div");
      thumbBox.className = "page-thumb";
      thumbBox.dataset.key = String(entry.key);
      if (entry.thumb) {
        const img = document.createElement("img");
        img.src = entry.thumb;
        img.alt = `Page ${entry.srcIndex + 1} of ${file ? file.name : ""}`;
        img.style.transform = entry.rotation
          ? `rotate(${entry.rotation}deg)` : "";
        thumbBox.appendChild(img);
      } else {
        const ph = document.createElement("span");
        ph.className = "thumb-placeholder";
        ph.textContent = "Loading preview…";
        thumbBox.appendChild(ph);
        thumbObserver.observe(thumbBox);
      }
      card.appendChild(thumbBox);

      const meta = document.createElement("div");
      meta.className = "page-meta";
      const check = document.createElement("input");
      check.type = "checkbox";
      check.className = "page-check";
      check.checked = entry.selected;
      check.title = "Tick to include in a selection download";
      check.setAttribute("aria-label", `Select page ${entry.srcIndex + 1}`);
      check.addEventListener("change", () => {
        entry.selected = check.checked;
        card.classList.toggle("selected", entry.selected);
        refreshTopBar();
      });
      const label = document.createElement("span");
      label.className = "page-label";
      label.textContent = `${file ? file.name : ""} · p.${entry.srcIndex + 1}`;
      label.title = label.textContent;
      const rotL = document.createElement("button");
      rotL.textContent = "↺";
      rotL.title = "Rotate left";
      rotL.setAttribute("aria-label", "Rotate page left");
      rotL.addEventListener("click", (ev) => {
        ev.stopPropagation();
        entry.rotation = (entry.rotation + 270) % 360;
        renderGrid();
      });
      const rotR = document.createElement("button");
      rotR.textContent = "↻";
      rotR.title = "Rotate right";
      rotR.setAttribute("aria-label", "Rotate page right");
      rotR.addEventListener("click", (ev) => {
        ev.stopPropagation();
        entry.rotation = (entry.rotation + 90) % 360;
        renderGrid();
      });
      const del = document.createElement("button");
      del.className = "page-delete";
      del.textContent = "×";
      del.title = "Delete page";
      del.setAttribute("aria-label", "Delete page");
      del.addEventListener("click", (ev) => {
        ev.stopPropagation();
        deletePage(entry.key);
      });
      meta.append(check, label, rotL, rotR, del);
      card.appendChild(meta);

      card.addEventListener("click", () => {
        activeKey = entry.key;
        document.querySelectorAll(".page-card.active").forEach((c) =>
          c.classList.remove("active"));
        card.classList.add("active");
      });
      card.addEventListener("dragstart", (ev) => {
        ev.dataTransfer.setData("text/plain", String(entry.key));
        ev.dataTransfer.effectAllowed = "move";
        card.classList.add("dragging");
      });
      card.addEventListener("dragend", () => {
        card.classList.remove("dragging");
        document.querySelectorAll(".page-card.drop-before").forEach((c) =>
          c.classList.remove("drop-before"));
      });
      card.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "move";
        card.classList.add("drop-before");
      });
      card.addEventListener("dragleave", () => {
        card.classList.remove("drop-before");
      });
      card.addEventListener("drop", (ev) => {
        ev.preventDefault();
        card.classList.remove("drop-before");
        const draggedKey = Number(ev.dataTransfer.getData("text/plain"));
        movePage(draggedKey, entry.key);
      });
      els.pageGrid.appendChild(card);
    });
  }

  function deletePage(key) {
    const idx = pages.findIndex((p) => p.key === key);
    if (idx === -1) return;
    pages.splice(idx, 1);
    setStatus(`Deleted a page. ${totalPages()} pages left.`);
    renderAll();
  }

  function movePage(draggedKey, beforeKey) {
    if (draggedKey === beforeKey) return;
    const from = pages.findIndex((p) => p.key === draggedKey);
    const to = pages.findIndex((p) => p.key === beforeKey);
    if (from === -1 || to === -1) return;
    const [moved] = pages.splice(from, 1);
    const insertAt = pages.findIndex((p) => p.key === beforeKey);
    pages.splice(insertAt, 0, moved);
    renderGrid();
    refreshTopBar();
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
    if (!file || !file.pdfjsDoc) return;
    try {
      const page = await file.pdfjsDoc.getPage(entry.srcIndex + 1);
      const base = page.getViewport({ scale: 1 });
      const scale = 160 / base.width;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({
        canvasContext: canvas.getContext("2d"),
        viewport,
      }).promise;
      entry.thumb = canvas.toDataURL("image/png");
      entry.thumbDone = true;
      const box = els.pageGrid.querySelector(
        `.page-thumb[data-key="${key}"]`);
      if (box) {
        box.innerHTML = "";
        const img = document.createElement("img");
        img.src = entry.thumb;
        img.alt = `Page ${entry.srcIndex + 1} of ${file.name}`;
        img.style.transform = entry.rotation
          ? `rotate(${entry.rotation}deg)` : "";
        box.appendChild(img);
      }
    } catch (err) {
      entry.thumbDone = true; // do not retry forever
    }
  }

  // ---- download ----------------------------------------------------------
  async function download() {
    const chosen = selectedPages().length > 0 ? selectedPages() : pages;
    if (chosen.length === 0) return;
    els.download.disabled = true;
    setStatus("Building your PDF…");
    try {
      const { PDFDocument, degrees } = window.PDFLib;
      const out = await PDFDocument.create();
      // copy in order, batching consecutive pages from the same file
      let i = 0;
      while (i < chosen.length) {
        const file = findFile(chosen[i].fileId);
        let j = i;
        const indices = [];
        while (j < chosen.length && chosen[j].fileId === file.id) {
          indices.push(chosen[j].srcIndex);
          j += 1;
        }
        const copied = await out.copyPages(file.doc, indices);
        copied.forEach((page, k) => {
          const rot = chosen[i + k].rotation;
          if (rot) {
            page.setRotation(degrees((page.getRotation().angle + rot) % 360));
          }
          out.addPage(page);
        });
        i = j;
      }
      const bytes = await out.save();
      const blob = new Blob([bytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const single = files.length === 1 && chosen.length === totalPages();
      a.download = single
        ? files[0].name.replace(/\.pdf$/i, "") + "-merged.pdf"
        : (selectedPages().length > 0 ? "extracted.pdf" : "merged.pdf");
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
      setStatus(`Done — downloaded ${chosen.length} page${chosen.length === 1 ? "" : "s"}.`);
    } catch (err) {
      showError("Something went wrong while building the PDF. Try again.");
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

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Delete" && activeKey !== null) {
      const target = ev.target;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      deletePage(activeKey);
      activeKey = null;
    }
  });

  // drag-and-drop files onto the whole window
  let dragDepth = 0;
  document.addEventListener("dragenter", (ev) => {
    ev.preventDefault();
    dragDepth += 1;
    els.dropzone.classList.add("drag-over");
  });
  document.addEventListener("dragleave", (ev) => {
    ev.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) els.dropzone.classList.remove("drag-over");
  });
  document.addEventListener("dragover", (ev) => ev.preventDefault());
  document.addEventListener("drop", (ev) => {
    ev.preventDefault();
    dragDepth = 0;
    els.dropzone.classList.remove("drag-over");
    if (ev.dataTransfer && ev.dataTransfer.files.length > 0) {
      addFiles(ev.dataTransfer.files);
    }
  });

  refreshTopBar();
})();
