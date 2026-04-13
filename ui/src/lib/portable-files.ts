import type { CompanyPortabilityFileEntry } from "@combyne/shared";

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".bmp", ".avif",
]);

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot).toLowerCase();
}

function mimeFromExtension(ext: string): string {
  switch (ext) {
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".svg": return "image/svg+xml";
    case ".webp": return "image/webp";
    case ".ico": return "image/x-icon";
    case ".bmp": return "image/bmp";
    case ".avif": return "image/avif";
    default: return "application/octet-stream";
  }
}

/**
 * Returns true when the file path looks like a binary image and the entry
 * contains base64-encoded data (or is otherwise representable as an image).
 */
export function isPortableImageFile(
  path: string,
  entry: CompanyPortabilityFileEntry,
): boolean {
  const ext = extensionOf(path);
  if (!IMAGE_EXTENSIONS.has(ext)) return false;
  if (typeof entry === "string") {
    // SVG files may be stored as plain text
    return ext === ".svg";
  }
  return entry.encoding === "base64";
}

/**
 * Build a data-URL suitable for an <img> src attribute from a portable file
 * entry. Returns `null` when the entry cannot be represented as an image.
 */
export function getPortableFileDataUrl(
  path: string,
  entry: CompanyPortabilityFileEntry,
): string | null {
  if (typeof entry === "string") {
    const ext = extensionOf(path);
    if (ext === ".svg") {
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(entry)}`;
    }
    return null;
  }

  const contentType = entry.contentType ?? mimeFromExtension(extensionOf(path));
  return `data:${contentType};base64,${entry.data}`;
}

/**
 * Extract the text content of a portable file entry, or `null` if the entry is
 * binary (base64-encoded and not decodable as UTF-8 text).
 */
export function getPortableFileText(
  entry: CompanyPortabilityFileEntry,
): string | null {
  if (typeof entry === "string") return entry;

  // base64-encoded entries are usually binary images; attempt decode only when
  // the content-type hints at text.
  if (
    entry.contentType &&
    (entry.contentType.startsWith("text/") ||
      entry.contentType === "application/json" ||
      entry.contentType === "application/yaml" ||
      entry.contentType === "application/x-yaml")
  ) {
    try {
      return atob(entry.data);
    } catch {
      return null;
    }
  }

  return null;
}
