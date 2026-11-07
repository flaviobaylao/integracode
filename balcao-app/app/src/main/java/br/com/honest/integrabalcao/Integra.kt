package br.com.honest.integrabalcao

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.Locale

/**
 * Cliente HTTP do INTEGRA. Sincrono de proposito: toda chamada roda num
 * executor das Activities, e HttpURLConnection puro evita arrastar OkHttp
 * para dentro de uma maquininha com pouca memoria.
 */
object Integra {

    data class Pendente(val id: String, val reference: String, val valorCentavos: Int, val itens: JSONArray)

    data class CredenciaisCielo(val clientID: String, val accessToken: String, val merchantCode: String?)

    data class Produto(
        val id: String,
        val codigo: String,
        val nome: String,
        val varejoCentavos: Int,
        val atacadoCentavos: Int,
        val temImagem: Boolean,
    ) {
        fun precoNa(tabela: String): Int = if (tabela == Carrinho.ATACADO) atacadoCentavos else varejoCentavos
        fun disponivelNa(tabela: String): Boolean = precoNa(tabela) > 0
    }

    data class Catalogo(val produtos: List<Produto>, val atacadoAPartirDeCentavos: Int)

    data class ClienteResumo(val id: String, val nome: String, val documento: String?)

    /** Vendedor que pode ser apontado numa venda (GET /api/lio-app/vendedores). */
    data class Vendedor(val id: String, val nome: String)

    private fun abrir(ctx: Context, caminho: String, metodo: String): HttpURLConnection {
        val c = URL(Config.INTEGRA_BASE_URL + caminho).openConnection() as HttpURLConnection
        c.requestMethod = metodo
        c.connectTimeout = 15000
        c.readTimeout = 20000
        c.setRequestProperty("Authorization", "Bearer " + Config.deviceToken(ctx))
        c.setRequestProperty("Accept", "application/json")
        return c
    }

    private fun ler(c: HttpURLConnection): String {
        val code = c.responseCode
        val stream = if (code in 200..299) c.inputStream else c.errorStream
        return stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
    }

    private fun escrever(c: HttpURLConnection, json: JSONObject) {
        c.outputStream.use { it.write(json.toString().toByteArray(Charsets.UTF_8)) }
    }

    /** Mensagem de erro legivel: o `message` do JSON, senao o corpo, senao o HTTP. */
    private fun erroDe(c: HttpURLConnection, corpo: String): IllegalStateException {
        var msg = corpo
        try { msg = JSONObject(corpo).optString("message", corpo) } catch (_: Exception) { }
        if (msg.isBlank()) msg = "HTTP " + c.responseCode
        return IllegalStateException(msg)
    }

    fun parear(ctx: Context, codigo: String): String {
        val c = URL(Config.INTEGRA_BASE_URL + "/api/lio-app/parear").openConnection() as HttpURLConnection
        c.requestMethod = "POST"
        c.connectTimeout = 15000
        c.readTimeout = 20000
        c.doOutput = true
        c.setRequestProperty("Accept", "application/json")
        c.setRequestProperty("Content-Type", "application/json; charset=utf-8")
        try {
            escrever(c, JSONObject().put("codigo", codigo.trim().uppercase(Locale.ROOT)))
            val corpo = ler(c)
            if (c.responseCode !in 200..299) throw erroDe(c, corpo)
            val token = JSONObject(corpo).optString("token", "")
            check(token.isNotBlank()) { "Resposta sem token." }
            return token
        } finally {
            c.disconnect()
        }
    }

    fun credenciais(ctx: Context): CredenciaisCielo {
        val c = abrir(ctx, "/api/lio-app/config", "GET")
        try {
            val corpo = ler(c)
            check(c.responseCode in 200..299) { "config HTTP ${c.responseCode}: $corpo" }
            val j = JSONObject(corpo)
            return CredenciaisCielo(
                j.getString("clientID"),
                j.getString("accessToken"),
                j.optString("merchantCode", "").takeIf { it.isNotBlank() },
            )
        } finally {
            c.disconnect()
        }
    }

    fun pedidosPendentes(ctx: Context): List<Pendente> {
        val c = abrir(ctx, "/api/lio-app/pedidos-pendentes", "GET")
        try {
            val corpo = ler(c)
            check(c.responseCode in 200..299) { "pendentes HTTP ${c.responseCode}: $corpo" }
            val arr = JSONObject(corpo).getJSONArray("pedidos")
            return (0 until arr.length()).map { i ->
                val j = arr.getJSONObject(i)
                Pendente(
                    j.getString("id"),
                    j.optString("reference", ""),
                    j.optInt("valorCentavos", 0),
                    j.optJSONArray("itens") ?: JSONArray(),
                )
            }
        } finally {
            c.disconnect()
        }
    }

    fun confirmarPago(ctx: Context, pedidoId: String, dados: JSONObject): String =
        postJson(ctx, "/api/lio-app/pedido/$pedidoId/pago", dados)

    fun informarCancelamento(ctx: Context, pedidoId: String, dados: JSONObject): String =
        postJson(ctx, "/api/lio-app/pedido/$pedidoId/cancelado", dados)

    private fun postJson(ctx: Context, caminho: String, dados: JSONObject): String {
        val c = abrir(ctx, caminho, "POST")
        c.doOutput = true
        c.setRequestProperty("Content-Type", "application/json; charset=utf-8")
        try {
            escrever(c, dados)
            val corpo = ler(c)
            check(c.responseCode in 200..299) { "HTTP ${c.responseCode}: $corpo" }
            return corpo
        } finally {
            c.disconnect()
        }
    }

    fun catalogo(ctx: Context): Catalogo {
        val c = abrir(ctx, "/api/lio-app/catalogo", "GET")
        try {
            val corpo = ler(c)
            check(c.responseCode in 200..299) { "catalogo HTTP ${c.responseCode}: $corpo" }
            val j = JSONObject(corpo)
            val arr = j.getJSONArray("produtos")
            val produtos = (0 until arr.length()).map { i ->
                val p = arr.getJSONObject(i)
                Produto(
                    p.getString("id"),
                    p.optString("codigo", ""),
                    p.optString("nome", ""),
                    p.optInt("varejoCentavos", 0),
                    p.optInt("atacadoCentavos", 0),
                    p.optBoolean("temImagem", false),
                )
            }
            return Catalogo(produtos, j.optInt("atacadoAPartirDeCentavos", 20000))
        } finally {
            c.disconnect()
        }
    }

    fun vendedores(ctx: Context): List<Vendedor> {
        val c = abrir(ctx, "/api/lio-app/vendedores", "GET")
        try {
            val corpo = ler(c)
            check(c.responseCode in 200..299) { "vendedores HTTP ${c.responseCode}: $corpo" }
            val arr = JSONObject(corpo).optJSONArray("vendedores") ?: JSONArray()
            return (0 until arr.length()).map { i ->
                val v = arr.getJSONObject(i)
                Vendedor(v.getString("id"), v.optString("nome", ""))
            }
        } finally {
            c.disconnect()
        }
    }

    fun criarVenda(
        ctx: Context,
        itens: List<Pair<String, Int>>,
        tabela: String,
        clienteId: String?,
        vendedorId: String?,
    ): Pendente {
        val c = abrir(ctx, "/api/lio-app/venda", "POST")
        c.doOutput = true
        c.setRequestProperty("Content-Type", "application/json; charset=utf-8")
        try {
            val arr = JSONArray()
            for ((produtoId, quantidade) in itens) {
                arr.put(JSONObject().put("produtoId", produtoId).put("quantidade", quantidade))
            }
            val body = JSONObject().put("itens", arr).put("tabela", tabela)
            if (!clienteId.isNullOrBlank()) body.put("clienteId", clienteId)
            if (!vendedorId.isNullOrBlank()) body.put("vendedorId", vendedorId)
            escrever(c, body)
            val corpo = ler(c)
            if (c.responseCode !in 200..299) throw erroDe(c, corpo)
            val j = JSONObject(corpo)
            return Pendente(
                j.getString("id"),
                j.optString("reference", ""),
                j.optInt("valorCentavos", 0),
                j.optJSONArray("itens") ?: JSONArray(),
            )
        } finally {
            c.disconnect()
        }
    }

    fun buscarClientes(ctx: Context, termo: String): List<ClienteResumo> {
        val c = abrir(ctx, "/api/lio-app/clientes?busca=" + URLEncoder.encode(termo, "UTF-8"), "GET")
        try {
            val corpo = ler(c)
            if (c.responseCode !in 200..299) return emptyList()
            val arr = JSONObject(corpo).optJSONArray("clientes") ?: return emptyList()
            return (0 until arr.length()).map { i ->
                val j = arr.getJSONObject(i)
                ClienteResumo(
                    j.getString("id"),
                    j.optString("nome", ""),
                    j.optString("documento", "").takeIf { it.isNotBlank() },
                )
            }
        } finally {
            c.disconnect()
        }
    }

    /**
     * Baixa a foto do produto para `destino`. Devolve o ETag novo, o mesmo
     * ETag quando o servidor respondeu 304, ou null em falha.
     */
    fun baixarImagem(ctx: Context, produtoId: String, destino: File, etagAtual: String?): String? {
        val c = abrir(ctx, "/api/lio-app/produto/$produtoId/imagem", "GET")
        if (!etagAtual.isNullOrBlank()) c.setRequestProperty("If-None-Match", etagAtual)
        try {
            if (c.responseCode == 304) return etagAtual
            if (c.responseCode !in 200..299) return null
            val tmp = File(destino.parentFile, destino.name + ".tmp")
            c.inputStream.use { entrada ->
                FileOutputStream(tmp).use { saida -> entrada.copyTo(saida) }
            }
            if (!tmp.renameTo(destino)) {
                tmp.copyTo(destino, overwrite = true)
                tmp.delete()
            }
            return c.getHeaderField("ETag") ?: ""
        } catch (_: Exception) {
            return null
        } finally {
            c.disconnect()
        }
    }

    fun relatarErro(ctx: Context, pedidoId: String, code: Int, reason: String) {
        val c = abrir(ctx, "/api/lio-app/pedido/$pedidoId/erro", "POST")
        c.doOutput = true
        c.setRequestProperty("Content-Type", "application/json; charset=utf-8")
        try {
            escrever(c, JSONObject().put("code", code).put("reason", reason))
            ler(c)
        } finally {
            c.disconnect()
        }
    }
}
