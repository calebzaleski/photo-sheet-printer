/*
 * pdf.js — a small PDF writer, just big enough to place images on pages.
 *
 * The point of writing this by hand rather than pulling in a library is
 * control over the image path: an ImageSource's bytes go into the file
 * untouched, so a JPEG in is the same JPEG out.
 */
window.PDFSheet = (function () {
  'use strict';

  /* ------------------------------------------------------------- matrices */

  // Row-vector convention, matching PDF's `cm` operator: [a b c d e f] is
  // [[a b 0],[c d 0],[e f 1]]. mul(A, B) applies A first, then B.
  function mul(A, B) {
    return [
      A[0] * B[0] + A[1] * B[2],
      A[0] * B[1] + A[1] * B[3],
      A[2] * B[0] + A[3] * B[2],
      A[2] * B[1] + A[3] * B[3],
      A[4] * B[0] + A[5] * B[2] + B[4],
      A[4] * B[1] + A[5] * B[3] + B[5]
    ];
  }

  // EXIF orientation as a unit-square -> unit-square map. PDF draws an image
  // into the unit square with its top-left corner at (0,1).
  var ORIENT = {
    1: [1, 0, 0, 1, 0, 0],
    2: [-1, 0, 0, 1, 1, 0],
    3: [-1, 0, 0, -1, 1, 1],
    4: [1, 0, 0, -1, 0, 1],
    5: [0, -1, -1, 0, 1, 1],
    6: [0, -1, 1, 0, 0, 1],
    7: [0, 1, 1, 0, 0, 0],
    8: [0, 1, -1, 0, 1, 0]
  };

  // User-applied rotation, in the same unit space.
  var ROTATE = { 0: ORIENT[1], 90: ORIENT[6], 180: ORIENT[3], 270: ORIENT[8] };

  /* -------------------------------------------------------------- writing */

  function latin1(str) {
    var out = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xFF;
    return out;
  }

  function num(v) {
    if (!isFinite(v)) return '0';
    var s = v.toFixed(4);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s === '-0' ? '0' : s;
  }

  function hex(bytes) {
    var s = '', i;
    for (i = 0; i < bytes.length; i++) {
      s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    }
    return s;
  }

  function Doc() {
    this.objects = [null]; // object 0 is the free-list head
  }

  Doc.prototype.alloc = function () {
    this.objects.push(null);
    return this.objects.length - 1;
  };

  Doc.prototype.put = function (id, dict, stream) {
    this.objects[id] = { dict: dict, stream: stream || null };
  };

  Doc.prototype.add = function (dict, stream) {
    var id = this.alloc();
    this.put(id, dict, stream);
    return id;
  };

  Doc.prototype.build = function () {
    var parts = [];
    var offset = 0;
    var offsets = new Array(this.objects.length);

    function push(chunk) {
      var b = typeof chunk === 'string' ? latin1(chunk) : chunk;
      parts.push(b);
      offset += b.length;
    }

    push('%PDF-1.7\n');
    push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A])); // binary hint

    for (var id = 1; id < this.objects.length; id++) {
      var obj = this.objects[id];
      offsets[id] = offset;
      push(id + ' 0 obj\n');
      if (obj.stream) {
        push(obj.dict.replace(/>>\s*$/, '/Length ' + obj.stream.length + ' >>'));
        push('\nstream\n');
        push(obj.stream);
        push('\nendstream');
      } else {
        push(obj.dict);
      }
      push('\nendobj\n');
    }

    var xrefAt = offset;
    var size = this.objects.length;
    var xref = 'xref\n0 ' + size + '\n0000000000 65535 f \n';
    for (var j = 1; j < size; j++) {
      var o = String(offsets[j]);
      while (o.length < 10) o = '0' + o;
      xref += o + ' 00000 n \n';
    }
    push(xref);

    var id1 = hex(crypto.getRandomValues(new Uint8Array(16)));
    push('trailer\n<< /Size ' + size + ' /Root 1 0 R /ID [<' + id1 + '><' + id1 + '>] >>\n');
    push('startxref\n' + xrefAt + '\n%%EOF\n');

    var total = 0, k;
    for (k = 0; k < parts.length; k++) total += parts[k].length;
    var out = new Uint8Array(total), at = 0;
    for (k = 0; k < parts.length; k++) { out.set(parts[k], at); at += parts[k].length; }
    return out;
  };

  /* --------------------------------------------------------------- images */

  function addImage(doc, src) {
    var d = '<< /Type /XObject /Subtype /Image' +
      ' /Width ' + src.pixelWidth +
      ' /Height ' + src.pixelHeight +
      ' /BitsPerComponent ' + src.bitsPerComponent;

    if (src.icc && src.icc.data && src.icc.data.length) {
      var iccId = doc.add(
        '<< /N ' + src.icc.n + ' /Alternate /' + baseSpaceName(src.icc.n) + ' >>',
        src.icc.data
      );
      // An ICCBased space is an array, not a bare stream reference. Getting
      // this wrong makes viewers reject the image and render a blank page.
      d += ' /ColorSpace [/ICCBased ' + iccId + ' 0 R]';
    } else if (src.colorSpace && src.colorSpace.indexed) {
      var pal = src.colorSpace.indexed;
      d += ' /ColorSpace [/Indexed /DeviceRGB ' + (pal.length / 3 - 1) + ' <' + hex(pal) + '>]';
    } else {
      d += ' /ColorSpace /' + src.colorSpace;
    }

    if (src.decodeArray) {
      d += ' /Decode [' + src.decodeArray.join(' ') + ']';
    }
    if (src.filter) {
      d += ' /Filter /' + src.filter;
    }
    if (src.decodeParms) {
      var p = src.decodeParms;
      d += ' /DecodeParms << /Predictor ' + p.Predictor +
           ' /Colors ' + p.Colors +
           ' /BitsPerComponent ' + p.BitsPerComponent +
           ' /Columns ' + p.Columns + ' >>';
    }
    d += ' >>';

    return doc.add(d, src.data);
  }

  function baseSpaceName(n) {
    return n === 1 ? 'DeviceGray' : n === 4 ? 'DeviceCMYK' : 'DeviceRGB';
  }

  /* ------------------------------------------------------------- geometry */

  // Where the photo sits inside its cell. Cells arrive with a top-left
  // origin; PDF wants bottom-left, so y is flipped here and nowhere else.
  function placement(cell, src, rotation, mode, pageHeight) {
    var unit = mul(ORIENT[src.orientation] || ORIENT[1], ROTATE[rotation] || ROTATE[0]);

    var dw = src.displayWidth;
    var dh = src.displayHeight;
    if (rotation === 90 || rotation === 270) { var t = dw; dw = dh; dh = t; }

    var scale = mode === 'cover'
      ? Math.max(cell.w / dw, cell.h / dh)
      : Math.min(cell.w / dw, cell.h / dh);

    // w/h are the dimensions the photo occupies on the page, already
    // reflecting both EXIF and user rotation. The unit map handles the turn
    // itself, so the rect it is composed with is simply the final rect.
    var w = dw * scale;
    var h = dh * scale;
    var x = cell.x + (cell.w - w) / 2;
    var y = pageHeight - (cell.y + (cell.h - h) / 2) - h;

    return mul(unit, [w, 0, 0, h, x, y]);
  }

  function cutMarks(cells, page, length) {
    var ops = '';
    var xs = {}, ys = {};
    cells.forEach(function (c) {
      xs[num(c.x)] = c.x;
      xs[num(c.x + c.w)] = c.x + c.w;
      ys[num(c.y)] = c.y;
      ys[num(c.y + c.h)] = c.y + c.h;
    });

    Object.keys(xs).forEach(function (k) {
      var x = xs[k];
      ops += num(x) + ' ' + num(page.h) + ' m ' + num(x) + ' ' + num(page.h - length) + ' l S\n';
      ops += num(x) + ' 0 m ' + num(x) + ' ' + num(length) + ' l S\n';
    });
    Object.keys(ys).forEach(function (k) {
      var y = page.h - ys[k];
      ops += '0 ' + num(y) + ' m ' + num(length) + ' ' + num(y) + ' l S\n';
      ops += num(page.w) + ' ' + num(y) + ' m ' + num(page.w - length) + ' ' + num(y) + ' l S\n';
    });
    return ops;
  }

  /* ----------------------------------------------------------------- main */

  /**
   * pages: [{ width, height, cells: [{ x, y, w, h, item }] }] in points,
   *        cell coordinates measured from the top-left of the page.
   * item:  { source, rotation } or null for an empty cell.
   */
  function render(pages, opts) {
    opts = opts || {};
    var doc = new Doc();
    var catalogId = 1;
    var pagesId = 2;
    doc.alloc();
    doc.alloc();

    // One XObject per distinct source, so repeating a photo across nine cells
    // stores its bytes exactly once.
    var imageIds = new Map();
    function imageFor(src) {
      if (!imageIds.has(src)) imageIds.set(src, addImage(doc, src));
      return imageIds.get(src);
    }

    var pageIds = [];

    pages.forEach(function (page) {
      var ops = '';
      var resources = [];

      if (opts.background) {
        ops += '1 1 1 rg 0 0 ' + num(page.width) + ' ' + num(page.height) + ' re f\n';
      }

      page.cells.forEach(function (cell) {
        if (!cell.item || !cell.item.source) return;
        var src = cell.item.source;
        var id = imageFor(src);
        var name = 'Im' + id;
        if (resources.indexOf(id) < 0) resources.push(id);

        var m = placement(cell, src, cell.item.rotation || 0, opts.fit || 'contain', page.height);

        ops += 'q\n';
        if (opts.fit === 'cover') {
          ops += num(cell.x) + ' ' + num(page.height - cell.y - cell.h) + ' ' +
                 num(cell.w) + ' ' + num(cell.h) + ' re W n\n';
        }
        ops += m.map(num).join(' ') + ' cm\n';
        ops += '/' + name + ' Do\nQ\n';
      });

      if (opts.borders) {
        ops += '0.5 w 0.6 0.6 0.6 RG\n';
        page.cells.forEach(function (cell) {
          ops += num(cell.x) + ' ' + num(page.height - cell.y - cell.h) + ' ' +
                 num(cell.w) + ' ' + num(cell.h) + ' re S\n';
        });
      }

      if (opts.cutMarks) {
        ops += '0.5 w 0 0 0 RG\n';
        ops += cutMarks(page.cells, { w: page.width, h: page.height }, 12);
      }

      var contentId = doc.add('<< >>', latin1(ops));

      var xobjects = resources.map(function (id) {
        return '/Im' + id + ' ' + id + ' 0 R';
      }).join(' ');

      var pageId = doc.add(
        '<< /Type /Page /Parent ' + pagesId + ' 0 R' +
        ' /MediaBox [0 0 ' + num(page.width) + ' ' + num(page.height) + ']' +
        ' /Resources << /XObject << ' + xobjects + ' >> >>' +
        ' /Contents ' + contentId + ' 0 R >>'
      );
      pageIds.push(pageId);
    });

    doc.put(pagesId,
      '<< /Type /Pages /Count ' + pageIds.length + ' /Kids [' +
      pageIds.map(function (id) { return id + ' 0 R'; }).join(' ') + '] >>');
    doc.put(catalogId, '<< /Type /Catalog /Pages ' + pagesId + ' 0 R >>');

    return doc.build();
  }

  return { render: render };
})();
