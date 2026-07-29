/*
 * image-source.js — turn a File into something a PDF can embed without
 * throwing away pixels.
 *
 * Three paths, best first:
 *
 *   1. JPEG  -> the compressed bytes are copied verbatim into the PDF as a
 *               DCTDecode stream. No decode, no re-encode, byte-identical.
 *   2. PNG   -> the zlib IDAT stream is copied verbatim as a FlateDecode
 *               stream with the PNG predictor. Also byte-identical.
 *   3. other -> decode once, then store the raw samples under lossless Flate.
 *               Bigger file, but still every original pixel.
 *
 * Only path 3 touches a canvas, and nothing here ever calls toDataURL /
 * toBlob, which are the usual places quality silently disappears.
 */
window.ImageSource = (function () {
  'use strict';

  var MAX_BYTES = 200 * 1024 * 1024;

  /* ---------------------------------------------------------------- utils */

  function u16(b, i) { return (b[i] << 8) | b[i + 1]; }
  function u32(b, i) {
    return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  }

  function ascii(bytes, offset, length) {
    var s = '';
    for (var i = 0; i < length; i++) s += String.fromCharCode(bytes[offset + i]);
    return s;
  }

  function concat(chunks) {
    var total = 0, i;
    for (i = 0; i < chunks.length; i++) total += chunks[i].length;
    var out = new Uint8Array(total), at = 0;
    for (i = 0; i < chunks.length; i++) { out.set(chunks[i], at); at += chunks[i].length; }
    return out;
  }

  // zlib-wrapped deflate, which is exactly what PDF's FlateDecode expects.
  // Every browser that ships CompressionStream produces the zlib wrapper for
  // 'deflate'; where it is missing we fall back to an uncompressed stream
  // rather than to a lossy encoder.
  function deflate(bytes) {
    if (typeof CompressionStream !== 'function') return Promise.resolve(null);
    try {
      var cs = new CompressionStream('deflate');
      var stream = new Blob([bytes]).stream().pipeThrough(cs);
      return new Response(stream).arrayBuffer().then(function (buf) {
        return new Uint8Array(buf);
      });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function inflate(bytes) {
    if (typeof DecompressionStream !== 'function') return Promise.resolve(null);
    try {
      var ds = new DecompressionStream('deflate');
      var stream = new Blob([bytes]).stream().pipeThrough(ds);
      return new Response(stream).arrayBuffer().then(function (buf) {
        return new Uint8Array(buf);
      }).catch(function () { return null; });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  /* ----------------------------------------------------------------- JPEG */

  // Markers that carry no length field.
  function isStandalone(m) {
    return m === 0x01 || (m >= 0xD0 && m <= 0xD9);
  }

  // SOF0/1/2 are the DCT modes every PDF consumer understands. SOF3 and the
  // arithmetic-coded modes (9-11, 13-15) are not valid DCTDecode input, so
  // those fall through to the decode path instead of producing a broken PDF.
  function isSupportedSOF(m) {
    return m === 0xC0 || m === 0xC1 || m === 0xC2;
  }
  function isAnySOF(m) {
    return m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC;
  }

  function readExifOrientation(seg) {
    // seg starts at "Exif\0\0"
    var tiff = 6;
    if (seg.length < tiff + 8) return 1;
    var le;
    if (seg[tiff] === 0x49 && seg[tiff + 1] === 0x49) le = true;
    else if (seg[tiff] === 0x4D && seg[tiff + 1] === 0x4D) le = false;
    else return 1;

    function r16(i) { return le ? (seg[i] | (seg[i + 1] << 8)) : u16(seg, i); }
    function r32(i) {
      return le
        ? ((seg[i] | (seg[i + 1] << 8) | (seg[i + 2] << 16) | (seg[i + 3] << 24)) >>> 0)
        : u32(seg, i);
    }

    if (r16(tiff + 2) !== 0x002A) return 1;
    var ifd = tiff + r32(tiff + 4);
    if (ifd + 2 > seg.length) return 1;

    var count = r16(ifd);
    for (var i = 0; i < count; i++) {
      var entry = ifd + 2 + i * 12;
      if (entry + 12 > seg.length) break;
      if (r16(entry) === 0x0112) {
        var v = r16(entry + 8);
        return (v >= 1 && v <= 8) ? v : 1;
      }
    }
    return 1;
  }

  function parseJPEG(bytes) {
    if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;

    var info = {
      width: 0, height: 0, components: 0, precision: 8,
      orientation: 1, icc: null, adobeTransform: -1, supported: false
    };
    var iccParts = [];
    var exifSeen = false;
    var i = 2;

    while (i < bytes.length - 1) {
      if (bytes[i] !== 0xFF) { i++; continue; }
      var marker = bytes[i + 1];
      // Fill bytes: any number of 0xFF may precede the marker code.
      while (marker === 0xFF && i + 2 < bytes.length) { i++; marker = bytes[i + 1]; }
      i += 2;

      if (marker === 0xD8 || isStandalone(marker)) continue;
      if (marker === 0xDA) break;              // start of scan: headers are done
      if (i + 2 > bytes.length) break;

      var len = u16(bytes, i);
      if (len < 2 || i + len > bytes.length) break;
      var seg = bytes.subarray(i + 2, i + len);

      if (isAnySOF(marker)) {
        if (seg.length >= 6) {
          info.precision = seg[0];
          info.height = u16(seg, 1);
          info.width = u16(seg, 3);
          info.components = seg[5];
          info.supported = isSupportedSOF(marker) && info.precision === 8;
        }
      } else if (marker === 0xE1 && !exifSeen && seg.length > 6 &&
                 ascii(seg, 0, 4) === 'Exif' && seg[4] === 0) {
        // Only the first Exif block counts. Some encoders append a second one,
        // and browsers orient by the first — the preview has to agree with the
        // PDF, so this matches them.
        exifSeen = true;
        info.orientation = readExifOrientation(seg);
      } else if (marker === 0xE2 && seg.length > 14 && ascii(seg, 0, 11) === 'ICC_PROFILE') {
        // Profiles larger than one segment are split across numbered chunks.
        iccParts.push({ seq: seg[12], data: seg.subarray(14) });
      } else if (marker === 0xEE && seg.length >= 12 && ascii(seg, 0, 5) === 'Adobe') {
        info.adobeTransform = seg[11];
      }

      i += len;
    }

    if (!info.width || !info.height) return null;

    if (iccParts.length) {
      iccParts.sort(function (a, b) { return a.seq - b.seq; });
      info.icc = concat(iccParts.map(function (p) { return p.data; }));
    }
    return info;
  }

  /* ------------------------------------------------------------------ PNG */

  var PNG_SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

  function parsePNG(bytes) {
    if (bytes.length < 8) return null;
    for (var s = 0; s < 8; s++) if (bytes[s] !== PNG_SIG[s]) return null;

    var out = {
      width: 0, height: 0, bitDepth: 8, colorType: 0, interlace: 0,
      palette: null, hasTRNS: false, idat: [], iccz: null
    };
    var i = 8;

    while (i + 8 <= bytes.length) {
      var len = u32(bytes, i);
      var type = ascii(bytes, i + 4, 4);
      var data = bytes.subarray(i + 8, i + 8 + len);
      if (i + 12 + len > bytes.length) break;

      if (type === 'IHDR') {
        out.width = u32(data, 0);
        out.height = u32(data, 4);
        out.bitDepth = data[8];
        out.colorType = data[9];
        if (data[10] !== 0 || data[11] !== 0) return null; // unknown compression/filter
        out.interlace = data[12];
      } else if (type === 'PLTE') {
        out.palette = data;
      } else if (type === 'tRNS') {
        out.hasTRNS = true;
      } else if (type === 'IDAT') {
        out.idat.push(data);
      } else if (type === 'iCCP') {
        var z = 0;
        while (z < data.length && data[z] !== 0) z++;   // profile name
        // z+1 is the compression method byte
        out.iccz = data.subarray(z + 2);
      } else if (type === 'IEND') {
        break;
      }

      i += 12 + len;
    }

    return out.width && out.height && out.idat.length ? out : null;
  }

  /* ------------------------------------------------- decode-and-store path */

  function decodeToBitmap(file) {
    if (typeof createImageBitmap === 'function') {
      // imageOrientation:'from-image' keeps this path consistent with the
      // EXIF handling on the passthrough path.
      return createImageBitmap(file, { imageOrientation: 'from-image' })
        .catch(function () { return decodeViaImg(file); });
    }
    return decodeViaImg(file);
  }

  function decodeViaImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('This file could not be decoded by your browser.'));
      };
      img.src = url;
    });
  }

  function rasterize(file) {
    return decodeToBitmap(file).then(function (bmp) {
      var w = bmp.width || bmp.naturalWidth;
      var h = bmp.height || bmp.naturalHeight;
      if (!w || !h) throw new Error('This file could not be decoded by your browser.');

      var canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      // Transparent pixels become white, which is what a printer would do
      // with them anyway.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();

      var rgba = ctx.getImageData(0, 0, w, h).data;
      var rgb = new Uint8Array(w * h * 3);
      for (var p = 0, q = 0; p < rgba.length; p += 4, q += 3) {
        rgb[q] = rgba[p];
        rgb[q + 1] = rgba[p + 1];
        rgb[q + 2] = rgba[p + 2];
      }

      return deflate(rgb).then(function (packed) {
        return {
          kind: 'raw',
          pixelWidth: w,
          pixelHeight: h,
          displayWidth: w,
          displayHeight: h,
          orientation: 1,
          colorSpace: 'DeviceRGB',
          bitsPerComponent: 8,
          data: packed || rgb,
          filter: packed ? 'FlateDecode' : null,
          decodeParms: null,
          icc: null,
          decodeArray: null,
          lossless: true,
          reEncoded: true
        };
      });
    });
  }

  /* ----------------------------------------------------------------- main */

  function fromFile(file) {
    if (file.size > MAX_BYTES) {
      return Promise.reject(new Error('File is larger than 200 MB.'));
    }

    return file.arrayBuffer().then(function (buf) {
      var bytes = new Uint8Array(buf);

      var jpg = parseJPEG(bytes);
      if (jpg && jpg.supported) return jpegSource(bytes, jpg);

      var png = parsePNG(bytes);
      if (png) {
        var passthrough = pngSource(bytes, png);
        if (passthrough) return passthrough;
      }

      return rasterize(file);
    });
  }

  function jpegSource(bytes, info) {
    var cs = info.components === 1 ? 'DeviceGray'
           : info.components === 4 ? 'DeviceCMYK'
           : 'DeviceRGB';

    // Adobe-produced CMYK JPEGs store inverted ink values.
    var decodeArray = null;
    if (info.components === 4 && info.adobeTransform >= 0) {
      decodeArray = [1, 0, 1, 0, 1, 0, 1, 0];
    }

    var swap = info.orientation >= 5 && info.orientation <= 8;

    return {
      kind: 'jpeg',
      pixelWidth: info.width,
      pixelHeight: info.height,
      displayWidth: swap ? info.height : info.width,
      displayHeight: swap ? info.width : info.height,
      orientation: info.orientation,
      colorSpace: cs,
      bitsPerComponent: 8,
      data: bytes,
      filter: 'DCTDecode',
      decodeParms: null,
      icc: info.icc && info.icc.length ? { data: info.icc, n: info.components } : null,
      decodeArray: decodeArray,
      lossless: true,
      reEncoded: false
    };
  }

  function pngSource(bytes, png) {
    // Interlaced data is reordered, and alpha is interleaved with colour, so
    // neither can be handed to PDF as-is. Those go through rasterize().
    if (png.interlace !== 0) return null;
    if (png.colorType === 4 || png.colorType === 6) return null;
    if (png.colorType === 3 && (png.hasTRNS || !png.palette)) return null;
    if (png.colorType === 0 && png.hasTRNS) return null;
    if (png.colorType === 2 && png.hasTRNS) return null;

    var colors, colorSpace;
    if (png.colorType === 0) {
      colors = 1;
      colorSpace = 'DeviceGray';
    } else if (png.colorType === 2) {
      colors = 3;
      colorSpace = 'DeviceRGB';
    } else if (png.colorType === 3) {
      colors = 1;
      colorSpace = { indexed: png.palette };
    } else {
      return null;
    }

    var src = {
      kind: 'png',
      pixelWidth: png.width,
      pixelHeight: png.height,
      displayWidth: png.width,
      displayHeight: png.height,
      orientation: 1,
      colorSpace: colorSpace,
      bitsPerComponent: png.bitDepth,
      data: concat(png.idat),
      filter: 'FlateDecode',
      // Predictor 15 tells the PDF reader that each row carries the PNG
      // filter byte, which is exactly how IDAT is laid out.
      decodeParms: {
        Predictor: 15,
        Colors: colors,
        BitsPerComponent: png.bitDepth,
        Columns: png.width
      },
      icc: null,
      decodeArray: null,
      lossless: true,
      reEncoded: false
    };

    if (png.iccz) {
      return inflate(png.iccz).then(function (profile) {
        if (profile && profile.length) src.icc = { data: profile, n: colors };
        return src;
      });
    }
    return src;
  }

  return { fromFile: fromFile, deflate: deflate };
})();
