import { mkdir, open, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const MiB = 1024 * 1024;
const MIME_TYPES = new Map([
  ["application/pdf", { family: "document", extension: ".pdf" }],
  ["application/msword", { family: "document", extension: ".doc" }],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", { family: "document", extension: ".docx" }],
  ["application/vnd.ms-excel", { family: "document", extension: ".xls" }],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", { family: "document", extension: ".xlsx" }],
  ["text/plain", { family: "document", extension: ".txt" }],
  ["text/csv", { family: "document", extension: ".csv" }],
  ["image/jpeg", { family: "photo", extension: ".jpg" }],
  ["image/png", { family: "photo", extension: ".png" }],
  ["image/webp", { family: "photo", extension: ".webp" }],
  ["image/heic", { family: "photo", extension: ".heic" }],
  ["image/heif", { family: "photo", extension: ".heif" }],
  ["video/mp4", { family: "video", extension: ".mp4" }],
  ["video/webm", { family: "video", extension: ".webm" }],
  ["video/quicktime", { family: "video", extension: ".mov" }]
]);
const ALLOWED_KINDS = new Set(["sow", "document", "photo", "video", "profile_photo", "signature"]);

const cleanName = (value) => path.basename(String(value || "work-file"))
  .normalize("NFKC")
  .replace(/[\u0000-\u001F\u007F]/gu, " ")
  .replace(/[^\p{L}\p{N}._() -]/gu, "-")
  .replace(/\s+/gu, " ")
  .trim()
  .slice(0, 180) || "work-file";

const safeSegment = (value) => {
  const segment = String(value || "");
  if (!/^[A-Za-z0-9_-]{1,120}$/u.test(segment)) throw new WorkFileError("The file destination is invalid.", "invalid_file_destination", 422);
  return segment;
};

export class WorkFileError extends Error {
  constructor(message, code = "work_file_failed", status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export class WorkFileStorage {
  constructor(dataDir, options = {}) {
    this.root = path.resolve(dataDir, "work-files");
    const requestedMb = Number(options.maxFileMb ?? process.env.MAX_TASK_FILE_MB ?? 50);
    this.maxFileBytes = Math.max(1, Math.min(Number.isFinite(requestedMb) ? requestedMb : 50, 100)) * MiB;
  }

  status() {
    return {
      provider: "railway_volume",
      maxFileBytes: this.maxFileBytes,
      acceptedMimeTypes: [...MIME_TYPES.keys()]
    };
  }

  async save(request, { scope, scopeId, kind, originalName }) {
    if (!ALLOWED_KINDS.has(kind)) throw new WorkFileError("Choose a valid work-file category.", "invalid_file_kind");
    const mimeType = String(request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    const type = MIME_TYPES.get(mimeType);
    if (!type) throw new WorkFileError("Upload a PDF, Office document, image, MP4, MOV, or WebM file.", "unsupported_work_file", 415);
    if (["sow", "document"].includes(kind) && type.family !== "document") {
      throw new WorkFileError("SOW and document files must use a supported document format.", "invalid_document_file");
    }
    if (["photo", "profile_photo", "signature"].includes(kind) && type.family !== "photo") {
      throw new WorkFileError("This upload must be a supported image.", "invalid_image_file");
    }
    if (kind === "video" && type.family !== "video") {
      throw new WorkFileError("This upload must be an MP4, MOV, or WebM video.", "invalid_video_file");
    }
    const contentLength = Number(request.headers["content-length"] || 0);
    if (contentLength > this.maxFileBytes) {
      throw new WorkFileError(`Each file must be ${Math.floor(this.maxFileBytes / MiB)} MB or smaller.`, "work_file_too_large", 413);
    }

    const safeScope = safeSegment(scope);
    const safeScopeId = safeSegment(scopeId);
    const id = randomUUID();
    const directory = path.join(this.root, safeScope, safeScopeId);
    const storedPath = path.join(safeScope, safeScopeId, `${id}${type.extension}`);
    const absolutePath = path.join(this.root, storedPath);
    await mkdir(directory, { recursive: true });
    const handle = await open(absolutePath, "wx", 0o600);
    let size = 0;
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > this.maxFileBytes) {
          throw new WorkFileError(`Each file must be ${Math.floor(this.maxFileBytes / MiB)} MB or smaller.`, "work_file_too_large", 413);
        }
        await handle.write(chunk);
      }
      if (!size) throw new WorkFileError("The uploaded file is empty.", "empty_work_file");
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(absolutePath).catch(() => {});
      throw error;
    }
    await handle.close();
    return {
      id,
      originalName: cleanName(originalName),
      storedPath,
      mimeType,
      family: type.family,
      kind,
      size
    };
  }

  pathFor(file) {
    const candidate = path.resolve(this.root, String(file?.storedPath || ""));
    const prefix = `${this.root}${path.sep}`;
    if (!candidate.startsWith(prefix)) throw new WorkFileError("The requested work file is invalid.", "invalid_file_path", 404);
    return candidate;
  }

  async inspect(file) {
    const filePath = this.pathFor(file);
    const details = await stat(filePath).catch(() => null);
    if (!details?.isFile()) throw new WorkFileError("Work file not found.", "work_file_not_found", 404);
    return { filePath, size: details.size };
  }

  async remove(file) {
    await unlink(this.pathFor(file)).catch(() => {});
  }
}

export const createWorkFileStorage = (dataDir, options) => new WorkFileStorage(dataDir, options);
