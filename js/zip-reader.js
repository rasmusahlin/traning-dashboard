/* Small, dependency-free ZIP reader used for Garmin activity exports. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(root);
  else root.ZipReader = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var DEFAULTS = {
    maxEntries: 1000,
    maxEntryBytes: 50 * 1024 * 1024,
    maxTotalBytes: 200 * 1024 * 1024,
    maxCompressionRatio: 2000,
    maxDepth: 3
  };

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  function crc32(bytes) {
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) {
      crc ^= bytes[i];
      for (var j = 0; j < 8; j++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function decodeName(bytes, flags) {
    try { return new TextDecoder((flags & 0x800) ? 'utf-8' : 'utf-8', { fatal: false }).decode(bytes); }
    catch (e) { return Array.from(bytes).map(function (c) { return String.fromCharCode(c); }).join(''); }
  }

  function safeName(name) {
    var normalized = name.replace(/\\/g, '/');
    if (!normalized || normalized.endsWith('/') || normalized[0] === '/' || /^[A-Za-z]:/.test(normalized)) return false;
    var parts = normalized.split('/');
    return !parts.some(function (part) { return !part || part === '.' || part === '..'; });
  }

  function locateEocd(bytes) {
    var start = Math.max(0, bytes.length - 65557);
    for (var i = bytes.length - 22; i >= start; i--) if (u32(bytes, i) === 0x06054b50) return i;
    throw new Error('Ogiltig ZIP-fil: slutpost saknas.');
  }

  function zipEntries(input, limits) {
    var bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    var eocd = locateEocd(bytes);
    var disk = u16(bytes, eocd + 4), diskStart = u16(bytes, eocd + 6);
    var count = u16(bytes, eocd + 10), centralSize = u32(bytes, eocd + 12), centralOffset = u32(bytes, eocd + 16);
    if (disk || diskStart || count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error('ZIP64 och flerdelsarkiv stöds inte.');
    if (count > limits.maxEntries || centralOffset + centralSize > bytes.length) throw new Error('ZIP-arkivet överskrider säker storleksgräns.');
    var entries = [], offset = centralOffset;
    for (var i = 0; i < count; i++) {
      if (offset + 46 > bytes.length || u32(bytes, offset) !== 0x02014b50) throw new Error('Ogiltig ZIP-fil: central katalog är skadad.');
      var flags = u16(bytes, offset + 8), method = u16(bytes, offset + 10), crc = u32(bytes, offset + 16);
      var compressedSize = u32(bytes, offset + 20), uncompressedSize = u32(bytes, offset + 24);
      var nameLength = u16(bytes, offset + 28), extraLength = u16(bytes, offset + 30), commentLength = u16(bytes, offset + 32);
      var localOffset = u32(bytes, offset + 42), end = offset + 46 + nameLength + extraLength + commentLength;
      if (end > bytes.length) throw new Error('Ogiltig ZIP-fil: central post är avklippt.');
      var name = decodeName(bytes.subarray(offset + 46, offset + 46 + nameLength), flags);
      if (safeName(name) && !(flags & 1)) {
        if (uncompressedSize > limits.maxEntryBytes || uncompressedSize > limits.maxTotalBytes) throw new Error('ZIP-post överskrider säker storleksgräns.');
        if (compressedSize && uncompressedSize / compressedSize > limits.maxCompressionRatio) throw new Error('ZIP-post har orimlig komprimeringsgrad.');
        entries.push({ name: name, flags: flags, method: method, crc: crc, compressedSize: compressedSize, uncompressedSize: uncompressedSize, localOffset: localOffset });
      }
      offset = end;
    }
    return { bytes: bytes, entries: entries };
  }

  async function inflateRaw(data) {
    if (typeof DecompressionStream !== 'function') throw new Error('Den här webbläsaren saknar stöd för ZIP-komprimering (DecompressionStream).');
    var stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function readZip(input, options) {
    var limits = Object.assign({}, DEFAULTS, options || {});
    var data = input instanceof Uint8Array ? input : new Uint8Array(input), parsed = zipEntries(data, limits), total = 0, output = [];
    for (var i = 0; i < parsed.entries.length; i++) {
      var entry = parsed.entries[i], local = entry.localOffset;
      if (local + 30 > data.length || u32(data, local) !== 0x04034b50) throw new Error('Ogiltig ZIP-fil: lokal post saknas.');
      var localNameLength = u16(data, local + 26), localExtraLength = u16(data, local + 28), start = local + 30 + localNameLength + localExtraLength, end = start + entry.compressedSize;
      if (end > data.length) throw new Error('Ogiltig ZIP-fil: postens data är avklippt.');
      var compressed = data.subarray(start, end), content;
      if (entry.method === 0) content = compressed.slice();
      else if (entry.method === 8) content = await inflateRaw(compressed);
      else throw new Error('ZIP-komprimeringsmetod stöds inte för ' + entry.name + '.');
      if (content.length !== entry.uncompressedSize) throw new Error('ZIP-postens storlek stämmer inte för ' + entry.name + '.');
      if (entry.crc && crc32(content) !== entry.crc) throw new Error('ZIP-postens checksumma stämmer inte för ' + entry.name + '.');
      total += content.length;
      if (total > limits.maxTotalBytes) throw new Error('ZIP-arkivet överskrider total storleksgräns.');
      output.push({ name: entry.name, bytes: content, method: entry.method, compressed_size: entry.compressedSize });
    }
    return output;
  }

  async function readFitFiles(input, options, depth, context, prefix) {
    options = Object.assign({}, DEFAULTS, options || {}); depth = depth || 0; context = context || { totalBytes: 0, entries: 0 }; prefix = prefix || '';
    if (depth > options.maxDepth) throw new Error('ZIP-nästningen överskrider säker gräns.');
    var entries = await readZip(input, options), fits = [];
    for (var i = 0; i < entries.length; i++) {
      context.entries++; if (context.entries > options.maxEntries) throw new Error('ZIP-arkivet innehåller för många poster.');
      var entry = entries[i]; context.totalBytes += entry.bytes.length;
      if (context.totalBytes > options.maxTotalBytes) throw new Error('ZIP-arkivet överskrider total storleksgräns.');
      var path = prefix ? prefix + '/' + entry.name : entry.name, lower = entry.name.toLowerCase();
      if (lower.endsWith('.fit')) fits.push({ name: path, bytes: entry.bytes });
      else if (lower.endsWith('.zip')) fits = fits.concat(await readFitFiles(entry.bytes, options, depth + 1, context, path.replace(/\.zip$/i, '')));
    }
    return fits;
  }

  async function readFitFilesFromFile(file, options) {
    if (!file || typeof file.arrayBuffer !== 'function') throw new Error('ZIP-underlaget kan inte läsas.');
    return readFitFiles(new Uint8Array(await file.arrayBuffer()), options, 0, null, file.name || 'archive');
  }

  return { readZip: readZip, readFitFiles: readFitFiles, readFitFilesFromFile: readFitFilesFromFile, crc32: crc32, DEFAULTS: DEFAULTS };
});
