package br.com.honest.integrabalcao

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

/**
 * Estado persistido do aparelho (SharedPreferences).
 *
 * Tudo que precisa sobreviver a ida-e-volta ao app da Cielo mora aqui: o deep
 * link devolve o controle numa Activity nova, sem memoria da anterior.
 */
object Config {
    const val INTEGRA_BASE_URL = "https://integracode-production.up.railway.app"

    const val OP_PAGAMENTO = "PAGAMENTO"
    const val OP_CANCELAMENTO = "CANCELAMENTO"

    private const val PREFS = "integra_balcao"
    private const val K_TOKEN = "device_token"
    private const val K_PEDIDO_EM_CURSO = "pedido_em_curso"
    private const val K_OPERACAO = "operacao_em_curso"
    private const val K_ULTIMA_VENDA = "ultima_venda"
    private const val K_FORMA = "forma_pagamento"
    private const val K_ITENS_VENDA = "itens_venda"
    private const val K_DANFE = "danfe_nfce"

    private fun prefs(ctx: Context): SharedPreferences = ctx.getSharedPreferences(PREFS, 0)

    fun deviceToken(ctx: Context): String = prefs(ctx).getString(K_TOKEN, "") ?: ""

    fun salvarDeviceToken(ctx: Context, token: String) {
        prefs(ctx).edit().putString(K_TOKEN, token.trim()).apply()
    }

    fun pedidoEmCurso(ctx: Context): String? =
        prefs(ctx).getString(K_PEDIDO_EM_CURSO, null)?.takeIf { it.isNotBlank() }

    fun marcarPedidoEmCurso(ctx: Context, id: String?) {
        prefs(ctx).edit().putString(K_PEDIDO_EM_CURSO, id ?: "").apply()
    }

    fun operacaoEmCurso(ctx: Context): String = prefs(ctx).getString(K_OPERACAO, OP_PAGAMENTO) ?: OP_PAGAMENTO

    fun marcarOperacao(ctx: Context, operacao: String) {
        prefs(ctx).edit().putString(K_OPERACAO, operacao).apply()
    }

    fun salvarUltimaVenda(ctx: Context, dados: JSONObject) {
        prefs(ctx).edit().putString(K_ULTIMA_VENDA, dados.toString()).apply()
    }

    fun ultimaVenda(ctx: Context): JSONObject? = lerJson(ctx, K_ULTIMA_VENDA)

    fun limparUltimaVenda(ctx: Context) {
        prefs(ctx).edit().remove(K_ULTIMA_VENDA).apply()
    }

    fun salvarForma(ctx: Context, forma: String) {
        prefs(ctx).edit().putString(K_FORMA, forma).apply()
    }

    fun forma(ctx: Context): String = prefs(ctx).getString(K_FORMA, "") ?: ""

    /**
     * Itens da venda em curso, guardados para o comprovante — o retorno da
     * Cielo nao traz o carrinho. Vendedor entra aqui pelo mesmo motivo.
     */
    fun salvarItensDaVenda(
        ctx: Context,
        linhas: List<Triple<String, Int, Int>>,
        tabela: String,
        cliente: String?,
        vendedor: String? = null,
    ) {
        val arr = JSONArray()
        for ((nome, qtd, unit) in linhas) {
            arr.put(JSONObject().put("nome", nome).put("qtd", qtd).put("unit", unit))
        }
        val j = JSONObject().put("itens", arr).put("tabela", tabela)
        if (!cliente.isNullOrBlank()) j.put("cliente", cliente)
        if (!vendedor.isNullOrBlank()) j.put("vendedor", vendedor)
        prefs(ctx).edit().putString(K_ITENS_VENDA, j.toString()).apply()
    }

    fun itensDaVenda(ctx: Context): JSONObject? = lerJson(ctx, K_ITENS_VENDA)

    fun salvarDanfe(ctx: Context, danfe: JSONObject?) {
        val e = prefs(ctx).edit()
        if (danfe == null) e.remove(K_DANFE) else e.putString(K_DANFE, danfe.toString())
        e.apply()
    }

    fun danfe(ctx: Context): JSONObject? = lerJson(ctx, K_DANFE)

    fun versao(ctx: Context): String = try {
        ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: "?"
    } catch (_: Exception) {
        "?"
    }

    private fun lerJson(ctx: Context, chave: String): JSONObject? {
        val s = prefs(ctx).getString(chave, null)?.takeIf { it.isNotBlank() } ?: return null
        return try { JSONObject(s) } catch (_: Exception) { null }
    }
}
