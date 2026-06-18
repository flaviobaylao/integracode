import { Response } from "express";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as nodePath from "path";

const IS_REPLIT = !!process.env.REPL_ID;
const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

// ─── GCS client (only on Replit) ──────────────────────────────────────────────
let _gcsClient: any = null;
if (IS_REPLIT) {
  try {
    const { Storage } = require("@google-cloud/storage");
    _gcsClient = new Storage({
      credentials: {
        audience: "replit",
        subject_token_type: "access_token",
        token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
        type: "external_account",
        credential_source: {
          url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
          format: { type: "json", subject_token_field_name: "access_token" },
        },
        universe_domain: "googleapis.com",
      },
      projectId: "",
    });
  } catch {
    console.warn("[objectStorage] @google-cloud/storage not available");
  }
}

export const objectStorageClient = _gcsClient;

// ─── Error ─────────────────────────────────────────────────────────────────────
export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

// ─── Local FS helpers ──────────────────────────────────────────────────────────
function getUploadDir(): string {
  const dir = process.env.UPLOAD_DIR || nodePath.join(process.cwd(), "uploads");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

class LocalFile {
  constructor(public filePath: string) {}
}

// ─── ObjectStorageService ──────────────────────────────────────────────────────
export class ObjectStorageService {
  getPublicObjectSearchPaths(): Array<string> {
    if (!IS_REPLIT) return [];
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || "";
    return Array.from(
      new Set(pathsStr.split(",").map((p) => p.trim()).filter((p) => p.length > 0))
    );
  }

  getPrivateObjectDir(): string {
    if (!IS_REPLIT) return getUploadDir();
    const dir = process.env.PRIVATE_OBJECT_DIR || "";
    if (!dir) throw new Error("PRIVATE_OBJECT_DIR not set.");
    return dir;
  }

  async searchPublicObject(filePath: string): Promise<any | null> {
    if (!IS_REPLIT) return null;
    for (const searchPath of this.getPublicObjectSearchPaths()) {
      const fullPath = `${searchPath}/${filePath}`;
      const { bucketName, objectName } = parseObjectPath(fullPath);
      const bucket = _gcsClient.bucket(bucketName);
      const file = bucket.file(objectName);
      const [exists] = await file.exists();
      if (exists) return file;
    }
    return null;
  }

  async downloadObject(file: any, res: Response, cacheTtlSec: number = 3600) {
    if (file instanceof LocalFile) {
      if (!fs.existsSync(file.filePath)) {
        if (!res.headersSent) res.status(404).json({ error: "File not found" });
        return;
      }
      const ext = nodePath.extname(file.filePath).toLowerCase();
      const mimeMap: Record<string, string> = {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".png": "image/png", ".gif": "image/gif",
        ".webp": "image/webp", ".pdf": "application/pdf",
      };
      const stat = fs.statSync(file.filePath);
      res.set({
        "Content-Type": mimeMap[ext] || "application/octet-stream",
        "Content-Length": String(stat.size),
        "Cache-Control": `private, max-age=${cacheTtlSec}`,
      });
      fs.createReadStream(file.filePath).pipe(res);
      return;
    }
    try {
      const [metadata] = await file.getMetadata();
      res.set({
        "Content-Type": metadata.contentType || "application/octet-stream",
        "Content-Length": metadata.size,
        "Cache-Control": `private, max-age=${cacheTtlSec}`,
      });
      const stream = file.createReadStream();
      stream.on("error", (err: Error) => {
        console.error("Stream error:", err);
        if (!res.headersSent) res.status(500).json({ error: "Error streaming file" });
      });
      stream.pipe(res);
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ error: "Error downloading file" });
    }
  }

  async getObjectEntityUploadURL(): Promise<string> {
    if (!IS_REPLIT) {
      const uuid = randomUUID();
      const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
      return `${baseUrl}/api/uploads/put/${uuid}`;
    }
    const privateObjectDir = this.getPrivateObjectDir();
    const objectId = randomUUID();
    const fullPath = `${privateObjectDir}/uploads/${objectId}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    return signObjectURL({ bucketName, objectName, method: "PUT", ttlSec: 900 });
  }

  async getObjectEntityFile(objectPath: string): Promise<any> {
    if (!IS_REPLIT) {
      if (!objectPath.startsWith("/objects/")) throw new ObjectNotFoundError();
      const uuid = objectPath.slice("/objects/".length);
      const uploadDir = getUploadDir();
      const files = fs.existsSync(uploadDir)
        ? fs.readdirSync(uploadDir).filter((f) => f.startsWith(uuid))
        : [];
      if (files.length === 0) throw new ObjectNotFoundError();
      return new LocalFile(nodePath.join(uploadDir, files[0]));
    }
    if (!objectPath.startsWith("/objects/")) throw new ObjectNotFoundError();
    const parts = objectPath.slice(1).split("/");
    if (parts.length < 2) throw new ObjectNotFoundError();
    const entityId = parts.slice(1).join("/");
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) entityDir = `${entityDir}/`;
    const { bucketName, objectName } = parseObjectPath(`${entityDir}${entityId}`);
    const bucket = _gcsClient.bucket(bucketName);
    const objectFile = bucket.file(objectName);
    const [exists] = await objectFile.exists();
    if (!exists) throw new ObjectNotFoundError();
    return objectFile;
  }

  normalizeObjectEntityPath(rawPath: string): string {
    if (!IS_REPLIT) {
      if (rawPath.includes("/api/uploads/put/")) {
        const uuid = rawPath.split("/api/uploads/put/")[1].split("?")[0];
        return `/objects/${uuid}`;
      }
      return rawPath;
    }
    if (!rawPath.startsWith("https://storage.googleapis.com/")) return rawPath;
    const url = new URL(rawPath);
    const rawObjectPath = url.pathname;
    let objectEntityDir = this.getPrivateObjectDir();
    if (!objectEntityDir.endsWith("/")) objectEntityDir = `${objectEntityDir}/`;
    if (!rawObjectPath.startsWith(objectEntityDir)) return rawObjectPath;
    const entityId = rawObjectPath.slice(objectEntityDir.length);
    return `/objects/${entityId}`;
  }

  async trySetObjectEntityAclPolicy(rawPath: string, aclPolicy: any): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!IS_REPLIT) return normalizedPath;
    if (!normalizedPath.startsWith("/")) return normalizedPath;
    const { setObjectAclPolicy } = await import("./objectAcl");
    const objectFile = await this.getObjectEntityFile(normalizedPath);
    await setObjectAclPolicy(objectFile, aclPolicy);
    return normalizedPath;
  }

  async canAccessObjectEntity({ userId, objectFile, requestedPermission }: {
    userId?: string; objectFile: any; requestedPermission?: any;
  }): Promise<boolean> {
    if (!IS_REPLIT || objectFile instanceof LocalFile) return true;
    const { canAccessObject, ObjectPermission } = await import("./objectAcl");
    return canAccessObject({
      userId,
      objectFile,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
function parseObjectPath(p: string): { bucketName: string; objectName: string } {
  if (!p.startsWith("/")) p = `/${p}`;
  const parts = p.split("/");
  if (parts.length < 3) throw new Error("Invalid object path");
  return { bucketName: parts[1], objectName: parts.slice(2).join("/") };
}

async function signObjectURL({ bucketName, objectName, method, ttlSec }: {
  bucketName: string; objectName: string;
  method: "GET" | "PUT" | "DELETE" | "HEAD"; ttlSec: number;
}): Promise<string> {
  const request = {
    bucket_name: bucketName, object_name: objectName, method,
    expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
  };
  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) }
  );
  if (!response.ok) throw new Error(`Failed to sign object URL: ${response.status}`);
  const { signed_url: signedURL } = await response.json();
  return signedURL;
}
