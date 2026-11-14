package br.com.honest.integrabalcao

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Environment
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import java.io.File
import java.io.FileOutputStream

/**
 * QR Code da NFC-e como PNG em Pictures/integra-balcao, que e onde o app de
 * impressao da Cielo consegue ler (ele nao enxerga o cache privado do app).
 */
object QrCode {
    private const val LADO = 320

    fun gerar(ctx: Context, conteudo: String): File? {
        if (conteudo.isBlank()) return null
        return try {
            val hints = mapOf(
                EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.H,
                EncodeHintType.CHARACTER_SET to "UTF-8",
                EncodeHintType.MARGIN to 1,
            )
            val matrix = QRCodeWriter().encode(conteudo, BarcodeFormat.QR_CODE, LADO, LADO, hints)
            val bmp = Bitmap.createBitmap(LADO, LADO, Bitmap.Config.RGB_565)
            for (x in 0 until LADO) for (y in 0 until LADO) {
                bmp.setPixel(x, y, if (matrix.get(x, y)) Color.BLACK else Color.WHITE)
            }
            val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "integra-balcao")
            if (!dir.exists()) dir.mkdirs()
            val f = File(dir, "qrcode-nfce.png")
            FileOutputStream(f).use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
            f
        } catch (_: Throwable) {
            null
        }
    }
}
