import { ObjectStorageService } from "./replit_integrations/object_storage";
import { nanoid } from "nanoid";

const objectStorageService = new ObjectStorageService();

interface MediaUploadResult {
  success: boolean;
  objectPath?: string;
  publicUrl?: string;
  error?: string;
}

export async function uploadWhatsAppMediaToStorage(
  mediaUrl: string,
  mediaType: string,
  originalFilename?: string
): Promise<MediaUploadResult> {
  try {
    console.log(`📤 [MEDIA-STORAGE] Iniciando upload de mídia: ${mediaType}`);
    
    const response = await fetch(mediaUrl);
    if (!response.ok) {
      throw new Error(`Falha ao baixar mídia: ${response.status}`);
    }
    
    const mediaBuffer = await response.arrayBuffer();
    const mediaBlob = new Blob([mediaBuffer]);
    
    const extension = getExtensionFromMimeType(mediaType, originalFilename);
    const filename = `whatsapp/${Date.now()}_${nanoid(8)}${extension}`;
    
    const uploadURL = await objectStorageService.getObjectEntityUploadURL();
    
    const uploadResponse = await fetch(uploadURL, {
      method: "PUT",
      body: mediaBlob,
      headers: {
        "Content-Type": mediaType || "application/octet-stream",
      },
    });
    
    if (!uploadResponse.ok) {
      throw new Error(`Falha no upload: ${uploadResponse.status}`);
    }
    
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);
    
    console.log(`✅ [MEDIA-STORAGE] Mídia salva com sucesso: ${objectPath}`);
    
    return {
      success: true,
      objectPath,
      publicUrl: objectPath,
    };
  } catch (error) {
    console.error("❌ [MEDIA-STORAGE] Erro ao salvar mídia:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Erro desconhecido",
    };
  }
}

export async function uploadMediaFromBase64(
  base64Data: string,
  mimeType: string,
  originalFilename?: string
): Promise<MediaUploadResult> {
  try {
    console.log(`📤 [MEDIA-STORAGE] Upload de mídia base64: ${mimeType}`);
    
    const base64Clean = base64Data.replace(/^data:[^;]+;base64,/, "");
    const binaryString = atob(base64Clean);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const mediaBlob = new Blob([bytes], { type: mimeType });
    
    const extension = getExtensionFromMimeType(mimeType, originalFilename);
    const filename = `whatsapp/${Date.now()}_${nanoid(8)}${extension}`;
    
    const uploadURL = await objectStorageService.getObjectEntityUploadURL();
    
    const uploadResponse = await fetch(uploadURL, {
      method: "PUT",
      body: mediaBlob,
      headers: {
        "Content-Type": mimeType || "application/octet-stream",
      },
    });
    
    if (!uploadResponse.ok) {
      throw new Error(`Falha no upload: ${uploadResponse.status}`);
    }
    
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);
    
    console.log(`✅ [MEDIA-STORAGE] Mídia base64 salva: ${objectPath}`);
    
    return {
      success: true,
      objectPath,
      publicUrl: objectPath,
    };
  } catch (error) {
    console.error("❌ [MEDIA-STORAGE] Erro no upload base64:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Erro desconhecido",
    };
  }
}

function getExtensionFromMimeType(mimeType: string, filename?: string): string {
  if (filename) {
    const ext = filename.split(".").pop();
    if (ext) return `.${ext}`;
  }
  
  const mimeMap: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/aac": ".aac",
    "video/mp4": ".mp4",
    "video/3gpp": ".3gp",
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/msword": ".doc",
    "application/vnd.ms-excel": ".xls",
    "text/plain": ".txt",
  };
  
  return mimeMap[mimeType] || ".bin";
}

export { objectStorageService };
