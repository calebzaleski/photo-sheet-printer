/*
 * app.js — settings, preview, and export wiring.
 *
 * The preview reads its geometry from the same Layout.compute() call that
 * feeds the PDF, so the two cannot drift apart.
 */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  var state = {
    items: [],       // { id, name, source, url, rotation }
    seq: 0,
    busy: false,
    dragFrom: null
  };

  var IMAGE_RE = /\.(jpe?g|png|webp|gif|avif|bmp|tiff?|heic|heif)$/i;

  /* ------------------------------------------------------------- settings */

  function readSettings() {
    var unit = $('unit').value;
    var sizing = $('sizing').value;
    var aw = 3, ah = 4;

    if (sizing === 'aspect') {
      var preset = $('aspect-preset').value;
      if (preset === 'custom') {
        aw = numberOr($('aspect-w'), 3);
        ah = numberOr($('aspect-h'), 4);
      } else {
        var parts = preset.split(':');
        aw = parseFloat(parts[0]);
        ah = parseFloat(parts[1]);
      }
    }

    return {
      page: $('page').value,
      orientation: $('orientation').value,
      unit: unit,
      rows: clampInt($('rows'), 1, 10, 3),
      cols: clampInt($('cols'), 1, 10, 3),
      margin: Math.max(0, numberOr($('margin'), 0.25)),
      gap: Math.max(0, numberOr($('gap'), 0.1)),
      sizing: sizing,
      aspectW: aw,
      aspectH: ah,
      cellW: Math.max(0.1, numberOr($('cell-w'), 2.5)),
      cellH: Math.max(0.1, numberOr($('cell-h'), 3.5)),
      fit: $('fit').value,
      cutMarks: $('cutmarks').checked,
      borders: $('borders').checked,
      background: $('background').checked
    };
  }

  function numberOr(el, fallback) {
    var v = parseFloat(el.value);
    return isFinite(v) ? v : fallback;
  }

  function clampInt(el, lo, hi, fallback) {
    var v = parseInt(el.value, 10);
    if (!isFinite(v)) v = fallback;
    return Math.min(hi, Math.max(lo, v));
  }

  /* ---------------------------------------------------------------- setup */

  function populate() {
    var page = $('page');
    Object.keys(Layout.PAGES).forEach(function (key) {
      var o = document.createElement('option');
      o.value = key;
      o.textContent = Layout.PAGES[key].label;
      page.appendChild(o);
    });
    page.value = 'letter';

    var cell = $('cell-preset');
    Object.keys(Layout.CELL_PRESETS).forEach(function (key) {
      var o = document.createElement('option');
      o.value = key;
      o.textContent = Layout.CELL_PRESETS[key].label;
      cell.appendChild(o);
    });
    var custom = document.createElement('option');
    custom.value = 'custom';
    custom.textContent = 'Custom…';
    cell.appendChild(custom);
    cell.value = 'wallet';
  }

  /* --------------------------------------------------------------- photos */

  function addFiles(fileList) {
    var files = Array.prototype.filter.call(fileList, function (f) {
      return (f.type && f.type.indexOf('image/') === 0) || IMAGE_RE.test(f.name);
    });
    if (!files.length) {
      setStatus('Those files were not recognised as images.', 'warn');
      return;
    }

    state.busy = true;
    updateControls();

    var failures = [];
    var loaded = 0;

    // One at a time: decoding several 50-megapixel files at once is a good
    // way to have the tab killed for memory.
    var chain = Promise.resolve();
    files.forEach(function (file, index) {
      chain = chain.then(function () {
        setStatus('Reading ' + (index + 1) + ' of ' + files.length + '…');
        return ImageSource.fromFile(file).then(function (source) {
          state.items.push({
            id: ++state.seq,
            name: file.name,
            source: source,
            url: URL.createObjectURL(file),
            rotation: 0
          });
          loaded++;
        }).catch(function (err) {
          failures.push(file.name + ' — ' + (err && err.message ? err.message : 'unreadable'));
        });
      });
    });

    chain.then(function () {
      state.busy = false;
      render();
      if (failures.length) {
        setStatus('Skipped ' + failures.length + ' file(s): ' + failures.join('; '), 'warn');
      } else {
        setStatus(loaded + ' photo' + (loaded === 1 ? '' : 's') + ' added.', 'ok');
      }
    });
  }

  function repeatToFill() {
    var s = readSettings();
    var slots = s.rows * s.cols;
    if (!state.items.length) {
      setStatus('Add at least one photo first.', 'warn');
      return;
    }
    if (state.items.length >= slots) {
      setStatus('Every cell on the sheet is already filled.', 'warn');
      return;
    }
    var base = state.items.slice();
    var i = 0;
    while (state.items.length < slots) {
      var src = base[i % base.length];
      // The source object is shared, so the PDF stores those bytes once no
      // matter how many cells the photo appears in.
      state.items.push({
        id: ++state.seq,
        name: src.name,
        source: src.source,
        url: src.url,
        rotation: src.rotation
      });
      i++;
    }
    render();
    setStatus('Filled all ' + slots + ' cells.', 'ok');
  }

  function clearAll() {
    var seen = {};
    state.items.forEach(function (it) {
      if (!seen[it.url]) { seen[it.url] = true; URL.revokeObjectURL(it.url); }
    });
    state.items = [];
    render();
    setStatus('');
  }

  function removeAt(index) {
    var item = state.items[index];
    if (!item) return;
    state.items.splice(index, 1);
    // Only release the blob URL once no remaining cell is using it.
    var stillUsed = state.items.some(function (it) { return it.url === item.url; });
    if (!stillUsed) URL.revokeObjectURL(item.url);
    render();
  }

  function rotateAt(index) {
    var item = state.items[index];
    if (!item) return;
    item.rotation = (item.rotation + 90) % 360;
    render();
  }

  function swap(a, b) {
    if (a === b || a == null || b == null) return;
    if (b >= state.items.length) {
      var moved = state.items.splice(a, 1)[0];
      state.items.push(moved);
    } else {
      var t = state.items[a];
      state.items[a] = state.items[b];
      state.items[b] = t;
    }
    render();
  }

  /* -------------------------------------------------------------- preview */

  function render() {
    var s = readSettings();
    var L = Layout.compute(s);
    var perPage = s.rows * s.cols;
    var pageCount = Math.max(1, Math.ceil(state.items.length / perPage));

    var host = $('sheets');
    host.textContent = '';

    var worstDPI = Infinity;

    for (var p = 0; p < pageCount; p++) {
      var sheet = document.createElement('div');
      sheet.className = 'sheet';
      sheet.style.aspectRatio = L.width + ' / ' + L.height;

      if (pageCount > 1) {
        var tag = document.createElement('div');
        tag.className = 'sheet-tag';
        tag.textContent = 'Page ' + (p + 1);
        sheet.appendChild(tag);
      }

      for (var i = 0; i < perPage; i++) {
        var geom = L.cells[i];
        var index = p * perPage + i;
        var item = state.items[index] || null;

        var cell = document.createElement('div');
        cell.className = 'cell' + (item ? '' : ' cell-empty');
        cell.style.left = pct(geom.x, L.width);
        cell.style.top = pct(geom.y, L.height);
        cell.style.width = pct(geom.w, L.width);
        cell.style.height = pct(geom.h, L.height);
        cell.dataset.index = String(index);
        if (s.borders) cell.classList.add('cell-bordered');

        if (item) {
          var dpi = Layout.effectiveDPI(item.source, item.rotation, geom, s.fit);
          if (dpi < worstDPI) worstDPI = dpi;
          fillCell(cell, item, geom, s, index, dpi);
        }

        sheet.appendChild(cell);
      }

      if (s.cutMarks) addCutMarks(sheet, L);
      host.appendChild(sheet);
    }

    updateCount(s, perPage * pageCount, worstDPI);
    updateControls();
    if (L.overflows) {
      setStatus('The grid is wider or taller than the page at this size — reduce the photo size, margin, or gap.', 'warn');
    }
  }

  function pct(value, total) {
    return (value / total * 100) + '%';
  }

  // Mirrors the marks pdf.js draws, so the preview shows where the cuts land.
  function addCutMarks(sheet, L) {
    var len = 12;
    var xs = {}, ys = {};
    L.cells.forEach(function (c) {
      xs[c.x] = true; xs[c.x + c.w] = true;
      ys[c.y] = true; ys[c.y + c.h] = true;
    });

    Object.keys(xs).forEach(function (k) {
      [0, L.height - len].forEach(function (top) {
        var m = sheet.appendChild(document.createElement('div'));
        m.className = 'mark';
        m.style.left = pct(parseFloat(k), L.width);
        m.style.top = pct(top, L.height);
        m.style.width = '1px';
        m.style.height = pct(len, L.height);
      });
    });

    Object.keys(ys).forEach(function (k) {
      [0, L.width - len].forEach(function (left) {
        var m = sheet.appendChild(document.createElement('div'));
        m.className = 'mark';
        m.style.left = pct(left, L.width);
        m.style.top = pct(parseFloat(k), L.height);
        m.style.height = '1px';
        m.style.width = pct(len, L.width);
      });
    });
  }

  function fillCell(cell, item, geom, s, index, dpi) {
    var src = item.source;
    var dw = src.displayWidth;
    var dh = src.displayHeight;
    if (item.rotation === 90 || item.rotation === 270) { var t = dw; dw = dh; dh = t; }

    var scale = s.fit === 'cover'
      ? Math.max(geom.w / dw, geom.h / dh)
      : Math.min(geom.w / dw, geom.h / dh);

    var drawnW = dw * scale;
    var drawnH = dh * scale;

    // The <img> box is measured before the CSS rotation is applied, so for a
    // quarter turn its width and height are the drawn values swapped.
    var boxW = (item.rotation === 90 || item.rotation === 270) ? drawnH : drawnW;
    var boxH = (item.rotation === 90 || item.rotation === 270) ? drawnW : drawnH;

    var img = document.createElement('img');
    img.src = item.url;
    img.alt = item.name;
    img.draggable = false;
    img.style.width = pct(boxW, geom.w);
    img.style.height = pct(boxH, geom.h);
    img.style.left = pct((geom.w - boxW) / 2, geom.w);
    img.style.top = pct((geom.h - boxH) / 2, geom.h);
    if (item.rotation) img.style.transform = 'rotate(' + item.rotation + 'deg)';
    cell.appendChild(img);

    var badge = document.createElement('span');
    badge.className = 'dpi ' + (dpi >= 300 ? 'dpi-good' : dpi >= 180 ? 'dpi-ok' : 'dpi-low');
    badge.textContent = Math.round(dpi) + ' ppi';
    badge.title = Math.round(dpi) + ' pixels per inch at this print size';
    cell.appendChild(badge);

    var tools = document.createElement('div');
    tools.className = 'tools';
    tools.appendChild(toolButton('⟳', 'Rotate ' + item.name, function () { rotateAt(index); }));
    tools.appendChild(toolButton('✕', 'Remove ' + item.name, function () { removeAt(index); }));
    cell.appendChild(tools);

    cell.draggable = true;
  }

  function toolButton(glyph, label, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'tool';
    b.textContent = glyph;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  function updateCount(s, totalCells, worstDPI) {
    var n = state.items.length;
    var parts = [];
    parts.push(n + ' photo' + (n === 1 ? '' : 's'));
    parts.push(n + ' of ' + totalCells + ' cells filled');

    if (n && isFinite(worstDPI)) {
      parts.push('lowest ' + Math.round(worstDPI) + ' ppi');
    }

    var reencoded = state.items.filter(function (it) { return it.source.reEncoded; }).length;
    if (reencoded) {
      parts.push(reencoded + ' stored as raw pixels');
    }

    $('count').textContent = n ? parts.join(' · ') : 'No photos yet. Drop them anywhere on this page.';
  }

  function updateControls() {
    $('export').disabled = state.busy || state.items.length === 0;
    $('pick').disabled = state.busy;
    $('repeat').disabled = state.busy;
  }

  function setStatus(text, kind) {
    var el = $('status');
    el.textContent = text || '';
    el.className = 'hint' + (kind ? ' hint-' + kind : '');
  }

  /* --------------------------------------------------------------- export */

  function exportPDF() {
    if (!state.items.length) return;
    var s = readSettings();
    var L = Layout.compute(s);
    var perPage = s.rows * s.cols;
    var pageCount = Math.max(1, Math.ceil(state.items.length / perPage));

    setStatus('Building PDF…');

    // Yield once so the status text paints before the synchronous build.
    setTimeout(function () {
      try {
        var pages = [];
        for (var p = 0; p < pageCount; p++) {
          var cells = L.cells.map(function (c, i) {
            var item = state.items[p * perPage + i] || null;
            return {
              x: c.x, y: c.y, w: c.w, h: c.h,
              item: item ? { source: item.source, rotation: item.rotation } : null
            };
          });
          pages.push({ width: L.width, height: L.height, cells: cells });
        }

        var bytes = PDFSheet.render(pages, {
          fit: s.fit,
          cutMarks: s.cutMarks,
          borders: s.borders,
          background: s.background
        });

        var blob = new Blob([bytes], { type: 'application/pdf' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'photo-sheet.pdf';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 20000);

        setStatus('Saved photo-sheet.pdf — ' + formatSize(bytes.length) + '.', 'ok');
      } catch (err) {
        setStatus('Could not build the PDF: ' + (err && err.message ? err.message : err), 'warn');
      }
    }, 30);
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  /* ----------------------------------------------------------------- bind */

  function convertUnits(from, to) {
    if (from === to) return;
    ['margin', 'gap', 'cell-w', 'cell-h'].forEach(function (id) {
      var el = $(id);
      var v = parseFloat(el.value);
      if (!isFinite(v)) return;
      var pt = Layout.toPt(v, from);
      el.value = round(Layout.fromPt(pt, to), to === 'mm' ? 1 : 2);
    });
    ['margin', 'gap'].forEach(function (id) { $(id).step = to === 'mm' ? '1' : '0.05'; });
    ['cell-w', 'cell-h'].forEach(function (id) { $(id).step = to === 'mm' ? '1' : '0.05'; });
    Array.prototype.forEach.call(document.querySelectorAll('.unit-label'), function (el) {
      el.textContent = to;
    });
  }

  function round(v, places) {
    var f = Math.pow(10, places);
    return Math.round(v * f) / f;
  }

  function bind() {
    $('pick').addEventListener('click', function () { $('file').click(); });
    $('file').addEventListener('change', function (e) {
      addFiles(e.target.files);
      e.target.value = '';
    });
    $('repeat').addEventListener('click', repeatToFill);
    $('clear').addEventListener('click', clearAll);
    $('export').addEventListener('click', exportPDF);

    var currentUnit = $('unit').value;
    $('unit').addEventListener('change', function () {
      convertUnits(currentUnit, $('unit').value);
      currentUnit = $('unit').value;
      render();
    });

    $('sizing').addEventListener('change', function () {
      var mode = $('sizing').value;
      $('aspect-fields').hidden = mode !== 'aspect';
      $('exact-fields').hidden = mode !== 'exact';
      render();
    });

    $('aspect-preset').addEventListener('change', function () {
      $('aspect-custom').hidden = $('aspect-preset').value !== 'custom';
      render();
    });

    $('cell-preset').addEventListener('change', function () {
      var preset = Layout.CELL_PRESETS[$('cell-preset').value];
      if (preset) {
        var unit = $('unit').value;
        $('cell-w').value = round(Layout.fromPt(preset.w * 72, unit), unit === 'mm' ? 1 : 2);
        $('cell-h').value = round(Layout.fromPt(preset.h * 72, unit), unit === 'mm' ? 1 : 2);
      }
      render();
    });

    ['page', 'orientation', 'rows', 'cols', 'margin', 'gap', 'aspect-w', 'aspect-h',
     'cell-w', 'cell-h', 'fit', 'cutmarks', 'borders', 'background'].forEach(function (id) {
      var el = $(id);
      el.addEventListener('change', render);
      if (el.tagName === 'INPUT' && el.type === 'number') {
        el.addEventListener('input', render);
      }
    });

    ['cell-w', 'cell-h'].forEach(function (id) {
      $(id).addEventListener('input', function () { $('cell-preset').value = 'custom'; });
    });

    bindDragAndDrop();
  }

  function bindDragAndDrop() {
    var host = $('sheets');

    host.addEventListener('dragstart', function (e) {
      var cell = e.target.closest ? e.target.closest('.cell') : null;
      if (!cell || cell.classList.contains('cell-empty')) return;
      state.dragFrom = parseInt(cell.dataset.index, 10);
      e.dataTransfer.effectAllowed = 'move';
      // Firefox will not start a drag without payload.
      e.dataTransfer.setData('text/plain', cell.dataset.index);
      cell.classList.add('dragging');
    });

    host.addEventListener('dragend', function () {
      state.dragFrom = null;
      Array.prototype.forEach.call(host.querySelectorAll('.cell'), function (c) {
        c.classList.remove('dragging', 'dragover');
      });
    });

    host.addEventListener('dragover', function (e) {
      if (state.dragFrom == null) return;
      var cell = e.target.closest ? e.target.closest('.cell') : null;
      if (!cell) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      cell.classList.add('dragover');
    });

    host.addEventListener('dragleave', function (e) {
      var cell = e.target.closest ? e.target.closest('.cell') : null;
      if (cell) cell.classList.remove('dragover');
    });

    host.addEventListener('drop', function (e) {
      if (state.dragFrom == null) return;
      var cell = e.target.closest ? e.target.closest('.cell') : null;
      if (!cell) return;
      e.preventDefault();
      swap(state.dragFrom, parseInt(cell.dataset.index, 10));
      state.dragFrom = null;
    });

    // Files dragged in from the desktop.
    var veil = $('dropveil');
    var depth = 0;

    window.addEventListener('dragenter', function (e) {
      if (!hasFiles(e)) return;
      depth++;
      veil.hidden = false;
    });
    window.addEventListener('dragover', function (e) {
      if (hasFiles(e)) e.preventDefault();
    });
    window.addEventListener('dragleave', function (e) {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) veil.hidden = true;
    });
    window.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      veil.hidden = true;
      addFiles(e.dataTransfer.files);
    });
  }

  function hasFiles(e) {
    if (!e.dataTransfer) return false;
    var types = e.dataTransfer.types;
    if (!types) return false;
    return Array.prototype.indexOf.call(types, 'Files') >= 0;
  }

  var boot = $('bootcheck');
  if (boot) boot.remove();

  populate();
  bind();
  render();
})();
