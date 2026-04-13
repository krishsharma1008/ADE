import type { CompanyPortabilityFileEntry } from "@combyne/shared";

/**
 * Minimal zip reader using the browser's DecompressionStream API.
 *
 * Reads a zip archive (as an ArrayBuffer) and returns the contained files as a
 * record of path -> CompanyPortabilityFileEntry, plus the detected root path
 * (common directory prefix) if one exists.
 */

// ── Zip reading (local-file-header walk) ─────────────────────────────

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const TEXT_DECODER = new TextDecoder();

function readUint16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}
function readUint32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".csv", ".xml",
  ".html", ".css", ".js", ".ts", ".tsx", ".jsx", ".sh", ".bash",
  ".py", ".rb", ".go", ".rs", ".java", ".sql", ".graphql", ".env",
  ".gitignore", ".editorconfig", ".prettierrc", ".eslintrc",
]);

function isTextPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return true; // extensionless files treated as text
  return TEXT_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

function detectRootPath(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const first = paths[0];
  const slash = first.indexOf("/");
  if (slash === -1) return null;
  const prefix = first.slice(0, slash + 1);
  if (paths.every((p) => p.startsWith(prefix))) return prefix.slice(0, -1);
  return null;
}

function inflateRaw(compressed: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  writer.write(compressed);
  writer.close();
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  return (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const totalLength = chunks.reduce((sum, c) => sum + c.byteLength, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  })();
}

export async function readZipArchive(
  buffer: ArrayBuffer,
): Promise<{
  rootPath: string | null;
  files: Record<string, CompanyPortabilityFileEntry>;
}> {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const files: Record<string, CompanyPortabilityFileEntry> = {};
  const paths: string[] = [];
  let offset = 0;

  while (offset + 30 <= bytes.byteLength) {
    const sig = readUint32(view, offset);
    if (sig !== LOCAL_FILE_HEADER_SIG) break;

    const compressionMethod = readUint16(view, offset + 8);
    const compressedSize = readUint32(view, offset + 18);
    const uncompressedSize = readUint32(view, offset + 22);
    const nameLen = readUint16(view, offset + 26);
    const extraLen = readUint16(view, offset + 28);
    const nameBytes = bytes.slice(offset + 30, offset + 30 + nameLen);
    const name = TEXT_DECODER.decode(nameBytes);
    const dataStart = offset + 30 + nameLen + extraLen;

    offset = dataStart + compressedSize;

    // Skip directories
    if (name.endsWith("/") || uncompressedSize === 0) continue;

    let rawData: Uint8Array;
    if (compressionMethod === 8) {
      // Deflate
      rawData = await inflateRaw(bytes.slice(dataStart, dataStart + compressedSize));
    } else {
      // Stored (method 0)
      rawData = bytes.slice(dataStart, dataStart + compressedSize);
    }

    paths.push(name);

    if (isTextPath(name)) {
      files[name] = TEXT_DECODER.decode(rawData);
    } else {
      // Binary content: store as base64
      let binary = "";
      for (let i = 0; i < rawData.byteLength; i++) {
        binary += String.fromCharCode(rawData[i]);
      }
      files[name] = {
        encoding: "base64" as const,
        data: btoa(binary),
      };
    }
  }

  const rootPath = detectRootPath(paths);

  // Strip root path prefix from keys if present
  if (rootPath) {
    const prefix = rootPath + "/";
    const stripped: Record<string, CompanyPortabilityFileEntry> = {};
    for (const [key, value] of Object.entries(files)) {
      stripped[key.startsWith(prefix) ? key.slice(prefix.length) : key] = value;
    }
    return { rootPath, files: stripped };
  }

  return { rootPath, files };
}

// ── Zip creation (store-only, no compression) ────────────────────────

const ENCODER = new TextEncoder();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.byteLength; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toBytes(entry: CompanyPortabilityFileEntry): Uint8Array {
  if (typeof entry === "string") {
    return ENCODER.encode(entry);
  }
  const binary = atob(entry.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Create a zip archive (as a Uint8Array) from a record of file entries.
 * Uses store method (no compression) for simplicity.
 */
export function createZipArchive(
  files: Record<string, CompanyPortabilityFileEntry>,
  rootPath: string,
): Uint8Array {
  const entries: Array<{
    name: Uint8Array;
    data: Uint8Array;
    crc: number;
    localHeaderOffset: number;
  }> = [];

  // Build all entries first to calculate total size
  const prefix = rootPath ? rootPath + "/" : "";

  const localHeaders: Uint8Array[] = [];
  let localOffset = 0;

  for (const [path, entry] of Object.entries(files)) {
    const fullPath = prefix + path;
    const nameBytes = ENCODER.encode(fullPath);
    const data = toBytes(entry);
    const crc = crc32(data);

    const headerSize = 30 + nameBytes.byteLength;
    const header = new Uint8Array(headerSize);
    const hv = new DataView(header.buffer);

    hv.setUint32(0, LOCAL_FILE_HEADER_SIG, true); // signature
    hv.setUint16(4, 20, true); // version needed
    hv.setUint16(6, 0, true); // flags
    hv.setUint16(8, 0, true); // compression (store)
    hv.setUint16(10, 0, true); // mod time
    hv.setUint16(12, 0, true); // mod date
    hv.setUint32(14, crc, true);
    hv.setUint32(18, data.byteLength, true); // compressed size
    hv.setUint32(22, data.byteLength, true); // uncompressed size
    hv.setUint16(26, nameBytes.byteLength, true);
    hv.setUint16(28, 0, true); // extra field length
    header.set(nameBytes, 30);

    entries.push({ name: nameBytes, data, crc, localHeaderOffset: localOffset });
    localHeaders.push(header);
    localOffset += headerSize + data.byteLength;
  }

  // Central directory
  const centralEntries: Uint8Array[] = [];
  for (const entry of entries) {
    const cdSize = 46 + entry.name.byteLength;
    const cd = new Uint8Array(cdSize);
    const cv = new DataView(cd.buffer);

    cv.setUint32(0, 0x02014b50, true); // central dir signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true); // flags
    cv.setUint16(10, 0, true); // compression
    cv.setUint16(12, 0, true); // mod time
    cv.setUint16(14, 0, true); // mod date
    cv.setUint32(16, entry.crc, true);
    cv.setUint32(20, entry.data.byteLength, true);
    cv.setUint32(24, entry.data.byteLength, true);
    cv.setUint16(28, entry.name.byteLength, true);
    cv.setUint16(30, 0, true); // extra field length
    cv.setUint16(32, 0, true); // comment length
    cv.setUint16(34, 0, true); // disk number start
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, entry.localHeaderOffset, true);
    cd.set(entry.name, 46);
    centralEntries.push(cd);
  }

  const centralDirSize = centralEntries.reduce((sum, e) => sum + e.byteLength, 0);

  // End of central directory
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralDirSize, true);
  ev.setUint32(16, localOffset, true);
  ev.setUint16(20, 0, true);

  // Assemble
  const totalSize = localOffset + centralDirSize + 22;
  const result = new Uint8Array(totalSize);
  let pos = 0;

  for (let i = 0; i < entries.length; i++) {
    result.set(localHeaders[i], pos);
    pos += localHeaders[i].byteLength;
    result.set(entries[i].data, pos);
    pos += entries[i].data.byteLength;
  }
  for (const cd of centralEntries) {
    result.set(cd, pos);
    pos += cd.byteLength;
  }
  result.set(eocd, pos);

  return result;
}
