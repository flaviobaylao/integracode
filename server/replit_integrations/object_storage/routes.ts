import type { Express } from "express";
import * as fs from "fs";
import * as nodePath from "path";
import { randomUUID } from "crypto";
import { ObjectStorageService, ObjectNotFoundError } from "./objectStorage";

const IS_REPLIT = !!process.env.REPL_ID;

function getUploadDir(): string {
  const dir = process.env.UPLOAD_DIR || nodePath.join(process.cwd(), "uploads");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Register object storage routes.
 *
 * On Replit: uses GCS presigned URL flow.
 * On Railway/local: uses server-side multer upload to local disk.
 *
 * Routes registered:
 *   POST /api/uploads/request-url  — get upload URL (presigned or local)
 *   PUT  /api/uploads/put/:uuid    — local-only: receive raw file bytes
 *   GET  /objects/:objectPath(*)   — serve stored file
 */
export function registerObjectStorageRoutes(app: Express): void {
  const objectStorageService = new ObjectStorageService();

  // ── Request upload URL ──────────────────────────────────────────────────────
  app.post("/api/uploads/request-url", async (req, res) => {
    try {
      const { name, size, contentType } = req.body;
      if (!name) return res.status(400).json({ error: "Missing required field: name" });

      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

      res.json({ uploadURL, objectPath, metadata: { name, size, contentType } });
    } catch (error) {
      console.error("Error generating upload URL:", error);
      res.status(500).json({ error: "Failed to generate upload URL" });
    }
  });

  // ── Local-only: receive raw PUT upload ──────────────────────────────────────
  if (!IS_REPLIT) {
    app.put("/api/uploads/put/:uuid", async (req, res) => {
      try {
        const { uuid } = req.params;
        if (!uuid || !/^[0-9a-f-]{36}$/i.test(uuid)) {
          return res.status(400).json({ error: "Invalid upload ID" });
        }

        const contentType = (req.headers["content-type"] || "application/octet-stream").split(";")[0].trim();

        // Buffer o corpo (mídia WhatsApp / anexos — tamanhos moderados).
        const chunks: Buffer[] = [];
        await new Promise<void>((resolve, reject) => {
          req.on("data", (c: Buffer) => chunks.push(c));
          req.on("end", () => resolve());
          req.on("error", reject);
        });
        const buf = Buffer.concat(chunks);
        if (buf.length > 25 * 1024 * 1024) {
          return res.status(413).json({ error: "Arquivo muito grande (limite 25MB)." });
        }

        if (process.env.UPLOAD_DIR) {
          // Modo DISCO: volume persistente montado (UPLOAD_DIR). Escalável p/ mídia grande.
          const extMap: Record<string, string> = {
            "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp",
            "application/pdf": ".pdf", "text/xml": ".xml", "application/xml": ".xml",
            "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/opus": ".opus", "audio/amr": ".amr",
            "video/mp4": ".mp4", "video/3gpp": ".3gp",
            "application/msword": ".doc", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
            "application/vnd.ms-excel": ".xls", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
            "text/plain": ".txt",
          };
          const ext = extMap[contentType] || "";
          const filePath = nodePath.join(getUploadDir(), `${uuid}${ext}`);
          fs.writeFileSync(filePath, buf);
        } else {
          // Modo BANCO (padrão no Railway): durável, sobrevive a deploys (disco é efêmero).
          const { db } = await import("../../db");
          const { sql } = await import("drizzle-orm");
          await db.execute(sql`INSERT INTO stored_objects (id, mime_type, size_bytes, content_base64, created_at) VALUES (${uuid}, ${contentType}, ${buf.length}, ${buf.toString("base64")}, now()) ON CONFLICT (id) DO UPDATE SET mime_type = EXCLUDED.mime_type, size_bytes = EXCLUDED.size_bytes, content_base64 = EXCLUDED.content_base64`);
        }

        res.status(200).json({ success: true, objectPath: `/objects/${uuid}` });
      } catch (error) {
        console.error("Error receiving upload:", error);
        res.status(500).json({ error: "Failed to save file" });
      }
    });
  }

  // ── Serve objects ────────────────────────────────────────────────────────────
  app.get("/objects/:objectPath(*)", async (req, res) => {
    try {
      const objectFile = await objectStorageService.getObjectEntityFile(req.path);
      await objectStorageService.downloadObject(objectFile, res);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        return res.status(404).json({ error: "Object not found" });
      }
      console.error("Error serving object:", error);
      res.status(500).json({ error: "Failed to serve object" });
    }
  });
}
