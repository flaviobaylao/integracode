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
        const extMap: Record<string, string> = {
          "image/jpeg": ".jpg", "image/png": ".png",
          "image/gif": ".gif", "image/webp": ".webp",
          "application/pdf": ".pdf",
        };
        const ext = extMap[contentType] || "";
        const fileName = `${uuid}${ext}`;
        const uploadDir = getUploadDir();
        const filePath = nodePath.join(uploadDir, fileName);

        const writeStream = fs.createWriteStream(filePath);
        req.pipe(writeStream);

        await new Promise<void>((resolve, reject) => {
          writeStream.on("finish", resolve);
          writeStream.on("error", reject);
          req.on("error", reject);
        });

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
