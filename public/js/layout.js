/*
 * layout.js — grid geometry in PDF points (72 per inch).
 *
 * The preview and the exported PDF both read their positions from here, which
 * is the only reason what you see on screen matches what comes out of the
 * printer.
 *
 * Cell coordinates use a top-left origin; pdf.js flips them on the way out.
 */
window.Layout = (function () {
  'use strict';

  var PT_PER_IN = 72;
  var PT_PER_MM = 72 / 25.4;

  var PAGES = {
    letter: { label: 'US Letter (8.5 × 11 in)', w: 612, h: 792 },
    legal:  { label: 'US Legal (8.5 × 14 in)',  w: 612, h: 1008 },
    a4:     { label: 'A4 (210 × 297 mm)',       w: 595.276, h: 841.89 },
    a5:     { label: 'A5 (148 × 210 mm)',       w: 419.528, h: 595.276 },
    p4x6:   { label: 'Photo 4 × 6 in',          w: 288, h: 432 },
    p5x7:   { label: 'Photo 5 × 7 in',          w: 360, h: 504 }
  };

  // Common physical print sizes, in inches.
  var CELL_PRESETS = {
    wallet:  { label: 'Wallet — 2.5 × 3.5 in', w: 2.5, h: 3.5 },
    p2x3:    { label: '2 × 3 in',              w: 2,   h: 3 },
    p3x4:    { label: '3 × 4 in',              w: 3,   h: 4 },
    p35x5:   { label: '3.5 × 5 in',            w: 3.5, h: 5 },
    p4x6:    { label: '4 × 6 in',              w: 4,   h: 6 }
  };

  function toPt(value, unit) {
    return unit === 'mm' ? value * PT_PER_MM : value * PT_PER_IN;
  }

  function fromPt(value, unit) {
    return unit === 'mm' ? value / PT_PER_MM : value / PT_PER_IN;
  }

  /**
   * opts: {
   *   page, orientation, rows, cols, unit,
   *   margin, gap,                 // in `unit`
   *   sizing: 'aspect' | 'fill' | 'exact',
   *   aspectW, aspectH,            // sizing === 'aspect'
   *   cellW, cellH                 // sizing === 'exact', in `unit`
   * }
   */
  function compute(opts) {
    var page = PAGES[opts.page] || PAGES.letter;
    var pw = page.w;
    var ph = page.h;
    if (opts.orientation === 'landscape') { var t = pw; pw = ph; ph = t; }

    var margin = toPt(opts.margin, opts.unit);
    var gap = toPt(opts.gap, opts.unit);
    var rows = Math.max(1, opts.rows | 0);
    var cols = Math.max(1, opts.cols | 0);

    var availW = pw - 2 * margin - (cols - 1) * gap;
    var availH = ph - 2 * margin - (rows - 1) * gap;

    var cellW, cellH;

    if (opts.sizing === 'exact') {
      cellW = toPt(opts.cellW, opts.unit);
      cellH = toPt(opts.cellH, opts.unit);
    } else if (opts.sizing === 'aspect') {
      // Largest cell of the requested shape that still fits the grid.
      var aspect = opts.aspectW / opts.aspectH;
      cellW = availW / cols;
      cellH = availH / rows;
      if (cellW / cellH > aspect) cellW = cellH * aspect;
      else cellH = cellW / aspect;
    } else {
      cellW = availW / cols;
      cellH = availH / rows;
    }

    cellW = Math.max(1, cellW);
    cellH = Math.max(1, cellH);

    var gridW = cols * cellW + (cols - 1) * gap;
    var gridH = rows * cellH + (rows - 1) * gap;

    // The grid block is centred on the page rather than pinned to the top
    // margin, so uneven leftovers split evenly and cuts stay symmetrical.
    var originX = (pw - gridW) / 2;
    var originY = (ph - gridH) / 2;

    var cells = [];
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        cells.push({
          x: originX + c * (cellW + gap),
          y: originY + r * (cellH + gap),
          w: cellW,
          h: cellH
        });
      }
    }

    return {
      width: pw,
      height: ph,
      cellW: cellW,
      cellH: cellH,
      cells: cells,
      overflows: gridW > pw - 2 * margin + 1e-6 || gridH > ph - 2 * margin + 1e-6
    };
  }

  /**
   * Effective print resolution for a photo drawn into a cell. This is the
   * number that decides whether a sheet looks sharp: 300 ppi is the usual
   * target for photo printing, 150 is where softness becomes visible.
   */
  function effectiveDPI(source, rotation, cell, fit) {
    var dw = source.displayWidth;
    var dh = source.displayHeight;
    if (rotation === 90 || rotation === 270) { var t = dw; dw = dh; dh = t; }

    var scale = fit === 'cover'
      ? Math.max(cell.w / dw, cell.h / dh)
      : Math.min(cell.w / dw, cell.h / dh);

    // scale is points-per-pixel; invert and convert to pixels per inch.
    return (1 / scale) * 72;
  }

  return {
    PAGES: PAGES,
    CELL_PRESETS: CELL_PRESETS,
    PT_PER_IN: PT_PER_IN,
    compute: compute,
    toPt: toPt,
    fromPt: fromPt,
    effectiveDPI: effectiveDPI
  };
})();
