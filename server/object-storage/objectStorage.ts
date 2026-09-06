import { Response } from "express";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as nodePath from "path";

// Armazenamento de arquivos do Integra 2.0 (E6, set/2026).
// Antes este modulo falava com o Object Storage (GCS via sidecar) quando o sistema rodava
// hospedado fora; hoje ha dois modos, os dois locais ao Railway:
//   - DISCO: quando UPLOAD_DIR aponta para um volume persistente;
//   - BANCO (padrao): tabela stored_objects — o disco do container e efemero.

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

function getUploadDir(): string {
  const dir = process.env.UPLOAD_DIR || nodePath.join(process.cwd(), "uploads");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

class LocalFile {
  constructor(public filePath: string) {}
}

// Objeto guardado no BANCO (tabela stored_objects).
class DbFile {
  constructor(public mime: string, public base64: string) {}
}

// true quando um volume persistente foi montado e configurado; senao, usa o banco.
export function useDiskStorage(): boolean {
  return !!process.env.UPLOAD_DIR;
}

export class ObjectStorageService {
  getPrivateObjectDir(): string {
    return getUploadDir();
  }

  async downloadObject(file: any, res: Response, cacheTtlSec: number = 3600) {
    if (file instanceof DbFile) {
      const buf = Buffer.from(file.base64, "base64");
      res.set({
        "Content-Type": file.mime || "application/octet-stream",
        "Content-Length": String(buf.length),
        "Cache-Control": `private, max-age=${cacheTtlSec}`,
      });
      res.end(buf);
      return;
    }
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
    if (!res.headersSent) res.status(404).json({ error: "File not found" });
  }

  async getObjectEntityUploadURL(): Promise<string> {
    const uuid = randomUUID();
    const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
    return `${baseUrl}/api/uploads/put/${uuid}`;
  }

  async getObjectEntityFile(objectPath: string): Promise<any> {
    if (!objectPath.startsWith("/objects/")) throw new ObjectNotFoundError();
    const uuid = objectPath.slice("/objects/".length);
    // 1) Arquivo em disco (volume UPLOAD_DIR ou uploads local herdado).
    const uploadDir = getUploadDir();
    const files = fs.existsSync(uploadDir)
      ? fs.readdirSync(uploadDir).filter((f) => f.startsWith(uuid))
      : [];
    if (files.length > 0) return new LocalFile(nodePath.join(uploadDir, files[0]));
    // 2) Fallback: objeto guardado no banco (stored_objects).
    try {
      const { db } = await import("../db");
      const { sql } = await import("drizzle-orm");
      const r: any = await db.execute(sql`SELECT mime_type, content_base64 FROM stored_objects WHERE id = ${uuid} LIMIT 1`);
      const row = r.rows?.[0];
      if (row && row.content_base64) return new DbFile(row.mime_type || "application/octet-stream", String(row.content_base64));
    } catch (e: any) {
      console.warn("[objectStorage] falha ao ler stored_objects:", e?.message);
    }
    throw new ObjectNotFoundError();
  }

  normalizeObjectEntityPath(rawPath: string): string {
    if (rawPath.includes("/api/uploads/put/")) {
      const uuid = rawPath.split("/api/uploads/put/")[1].split("?")[0];
      return `/objects/${uuid}`;
    }
    return rawPath;
  }

  // Sem ACL por objeto: quem chega aqui ja passou pelo middleware de sessao.
  async trySetObjectEntityAclPolicy(rawPath: string, _aclPolicy?: any): Promise<string> {
    return this.normalizeObjectEntityPath(rawPath);
  }

  async canAccessObjectEntity(_args: { userId?: string; objectFile: any; requestedPermission?: any }): Promise<boolean> {
    return true;
  }
}
