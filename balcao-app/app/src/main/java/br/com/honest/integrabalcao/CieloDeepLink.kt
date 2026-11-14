package br.com.honest.integrabalcao

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject

/**
 * Integracao por Deep Link com o app de pagamento da Cielo Smart (uriappclient).
 * Contrato: lio://<operacao>?request=<base64 do JSON>&urlCallback=order://response
 */
object CieloDeepLink {
    const val CALLBACK = "order://response"
    private const val SCHEME = "lio"
    private const val OP_PAGAMENTO = "payment"
    private const val OP_CANCELAMENTO = "payment-reversal"
    private const val OP_IMPRESSAO = "print"

    object Pagamento {
        const val DEBITO_AVISTA = "DEBITO_AVISTA"
        const val CREDITO_AVISTA = "CREDITO_AVISTA"
        const val CREDITO_PARCELADO_LOJA = "CREDITO_PARCELADO_LOJA"
        const val PIX = "PIX"
    }

    private fun base64(json: JSONObject): String =
        Base64.encodeToString(json.toString().toByteArray(Charsets.UTF_8), Base64.NO_WRAP)

    private fun disparar(activity: Activity, operacao: String, json: JSONObject) {
        val uri = Uri.Builder()
            .scheme(SCHEME)
            .authority(operacao)
            .appendQueryParameter("request", base64(json))
            .appendQueryParameter("urlCallback", CALLBACK)
            .build()
        val intent = Intent(Intent.ACTION_VIEW, uri)
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)
        activity.startActivity(intent)
    }

    fun cobrar(
        activity: Activity,
        credenciais: Integra.CredenciaisCielo,
        valorCentavos: Int,
        paymentCode: String,
        reference: String?,
        itens: JSONArray? = null,
        parcelas: Int = 0,
    ) {
        require(valorCentavos > 0) { "valor deve ser positivo, em centavos" }
        val items = itens ?: JSONArray().put(
            JSONObject()
                .put("name", "Venda balcao")
                .put("quantity", 1)
                .put("sku", "BALCAO")
                .put("unitOfMeasure", "unidade")
                .put("unitPrice", valorCentavos),
        )
        val json = JSONObject()
            .put("clientID", credenciais.clientID)
            .put("accessToken", credenciais.accessToken)
            .put("installments", parcelas)
            .put("items", items)
            .put("paymentCode", paymentCode)
            .put("value", valorCentavos.toString())
        if (!reference.isNullOrBlank()) json.put("reference", reference)
        credenciais.merchantCode?.let { json.put("merchantCode", it) }
        disparar(activity, OP_PAGAMENTO, json)
    }

    fun cancelar(
        activity: Activity,
        credenciais: Integra.CredenciaisCielo,
        orderId: String,
        cieloCode: String,
        authCode: String,
        valorCentavos: Int,
    ) {
        val json = JSONObject()
            .put("id", orderId)
            .put("clientID", credenciais.clientID)
            .put("accessToken", credenciais.accessToken)
            .put("cieloCode", cieloCode)
            .put("authCode", authCode)
            .put("value", valorCentavos)
        disparar(activity, OP_CANCELAMENTO, json)
    }

    fun imprimirTexto(activity: Activity, texto: String) {
        val json = JSONObject()
            .put("operation", "PRINT_TEXT")
            .put("styles", JSONArray().put(JSONObject()))
            .put("value", JSONArray().put(texto))
        disparar(activity, OP_IMPRESSAO, json)
    }

    fun imprimirImagem(activity: Activity, caminhoArquivo: String) {
        val json = JSONObject()
            .put("operation", "PRINT_IMAGE")
            .put("styles", JSONArray().put(JSONObject()))
            .put("value", JSONArray().put(caminhoArquivo))
        disparar(activity, OP_IMPRESSAO, json)
    }

    sealed class Retorno {
        data class Sucesso(val json: JSONObject) : Retorno()
        data class Erro(val code: Int, val reason: String) : Retorno()
        data class Ilegivel(val bruto: String) : Retorno()
    }

    fun lerRetorno(uri: Uri?): Retorno {
        val response = uri?.getQueryParameter("response") ?: return Retorno.Ilegivel("")
        val texto = try {
            String(Base64.decode(response, Base64.DEFAULT), Charsets.UTF_8)
        } catch (_: Exception) {
            return Retorno.Ilegivel(response)
        }
        return try {
            val j = JSONObject(texto)
            if (j.has("code") && !j.has("payments")) {
                Retorno.Erro(j.optInt("code", 2), j.optString("reason", j.optString("message", "")))
            } else {
                Retorno.Sucesso(j)
            }
        } catch (_: Exception) {
            Retorno.Ilegivel(texto)
        }
    }

    fun extrairDados(j: JSONObject): JSONObject {
        val payments = j.optJSONArray("payments") ?: JSONArray()
        val p = if (payments.length() > 0) payments.getJSONObject(0) else JSONObject()
        val fields = p.optJSONObject("paymentFields") ?: JSONObject()
        return JSONObject()
            .put("orderId", j.optString("id", ""))
            .put("reference", j.optString("reference", ""))
            .put("paidAmount", j.optInt("paidAmount", 0))
            .put("paymentTransactionId", fields.optString("paymentTransactionId", p.optString("externalId", "")))
            .put("authCode", p.optString("authCode", ""))
            .put("cieloCode", p.optString("cieloCode", ""))
            .put("brand", p.optString("brand", ""))
            .put("mask", p.optString("mask", ""))
            .put("installments", p.optInt("installments", 0))
            .put("terminal", p.optString("terminal", ""))
            .put("statusCode", fields.optString("statusCode", ""))
    }
}
