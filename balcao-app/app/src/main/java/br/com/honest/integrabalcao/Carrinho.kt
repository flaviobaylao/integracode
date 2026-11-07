package br.com.honest.integrabalcao

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.File

/** Formatacao de dinheiro em centavos, sem ponto flutuante. */
object Dinheiro {
    fun reais(centavos: Int): String {
        val sinal = if (centavos < 0) "-" else ""
        val abs = Math.abs(centavos)
        return String.format("$sinal%d,%02d", abs / 100, abs % 100)
    }

    fun rs(centavos: Int): String = "R$ " + reais(centavos)
}

/** Nomes de produto encurtados para a grade e para o papel de 32 colunas. */
object Nomes {
    private val PREFIXOS = listOf("SUCO MISTO DE FRUTA - ", "SUCO MISTO DE FRUTAS - ", "SUCO MISTO DE FRUTA ")

    fun curto(nome: String): String {
        val n = nome.trim()
        for (p in PREFIXOS) {
            if (n.startsWith(p, ignoreCase = true)) return n.substring(p.length).trim()
        }
        return n
    }

    fun quebrar(nome: String, colunas: Int, maxLinhas: Int = 2): List<String> {
        val c = curto(nome)
        if (c.length <= colunas) return listOf(c)
        val linhas = ArrayList<String>()
        var atual = StringBuilder()
        for (palavra in c.split(" ")) {
            val tentativa = if (atual.isEmpty()) palavra else "$atual $palavra"
            if (tentativa.length <= colunas) {
                atual = StringBuilder(tentativa)
            } else {
                if (atual.isNotEmpty()) linhas.add(atual.toString())
                atual = StringBuilder(palavra.take(colunas))
                if (linhas.size == maxLinhas) break
            }
        }
        if (linhas.size < maxLinhas && atual.isNotEmpty()) linhas.add(atual.toString())
        return linhas.take(maxLinhas)
    }
}

/**
 * Carrinho da venda em montagem. Singleton de proposito: a Activity pode ser
 * recriada no meio da venda e o carrinho tem que sobreviver.
 */
object Carrinho {
    const val VAREJO = "varejo"
    const val ATACADO = "atacado"

    private val itens = LinkedHashMap<String, Int>()

    var tabela: String = VAREJO
        private set
    var clienteId: String? = null
        private set
    var clienteNome: String? = null
        private set

    /**
     * Vendedor da venda (nov/2026). Obrigatorio para cobrar e esquecido ao fim
     * de cada venda: cada cobranca e apontada de novo, para contar no
     * resultado de quem realmente atendeu.
     */
    var vendedorId: String? = null
        private set
    var vendedorNome: String? = null
        private set

    fun quantidade(produtoId: String): Int = itens[produtoId] ?: 0

    fun somar(produtoId: String, delta: Int) {
        val novo = (itens[produtoId] ?: 0) + delta
        if (novo <= 0) itens.remove(produtoId) else itens[produtoId] = Math.min(novo, 999)
    }

    fun definir(produtoId: String, q: Int) {
        if (q <= 0) itens.remove(produtoId) else itens[produtoId] = Math.min(q, 999)
    }

    fun trocarTabela(nova: String) {
        tabela = nova
    }

    fun identificarCliente(id: String?, nome: String?) {
        clienteId = id
        clienteNome = nome
    }

    fun apontarVendedor(id: String?, nome: String?) {
        vendedorId = id
        vendedorNome = nome
    }

    fun vazio(): Boolean = itens.isEmpty()

    fun totalItens(): Int = itens.values.sum()

    fun paraEnvio(): List<Pair<String, Int>> = itens.entries.map { it.key to it.value }

    fun totalCentavos(catalogo: List<Integra.Produto>): Int {
        val porId = catalogo.associateBy { it.id }
        var total = 0
        for ((id, q) in itens) {
            val p = porId[id] ?: continue
            val preco = p.precoNa(tabela)
            if (preco > 0) total += preco * q
        }
        return total
    }

    fun itensBloqueados(catalogo: List<Integra.Produto>): List<Integra.Produto> {
        val porId = catalogo.associateBy { it.id }
        return itens.keys.mapNotNull { porId[it] }.filter { !it.disponivelNa(tabela) }
    }

    fun linhasComprovante(catalogo: List<Integra.Produto>): List<Triple<String, Int, Int>> {
        val porId = catalogo.associateBy { it.id }
        return itens.entries.mapNotNull { (id, q) ->
            val p = porId[id] ?: return@mapNotNull null
            Triple(p.nome, q, p.precoNa(tabela))
        }
    }

    fun limpar() {
        itens.clear()
        clienteId = null
        clienteNome = null
        vendedorId = null
        vendedorNome = null
    }
}

/** Fotos dos produtos: memoria -> disco (cache dir) -> servidor, com ETag. */
object FotoCache {
    private const val PREFS = "integra_fotos"
    private val memoria = HashMap<String, Bitmap>()

    private fun dir(ctx: Context): File {
        val d = File(ctx.cacheDir, "produtos")
        if (!d.exists()) d.mkdirs()
        return d
    }

    private fun arquivo(ctx: Context, produtoId: String) = File(dir(ctx), "$produtoId.jpg")

    private fun etag(ctx: Context, produtoId: String): String? =
        ctx.getSharedPreferences(PREFS, 0).getString(produtoId, null)

    private fun salvarEtag(ctx: Context, produtoId: String, valor: String?) {
        ctx.getSharedPreferences(PREFS, 0).edit().putString(produtoId, valor ?: "").apply()
    }

    fun emMemoria(produtoId: String): Bitmap? = memoria[produtoId]

    fun carregar(ctx: Context, produtoId: String, larguraAlvoPx: Int): Bitmap? {
        memoria[produtoId]?.let { return it }
        val f = arquivo(ctx, produtoId)
        if (!f.exists() || f.length() == 0L) {
            salvarEtag(ctx, produtoId, Integra.baixarImagem(ctx, produtoId, f, null))
        }
        if (!f.exists() || f.length() == 0L) return null
        val bmp = decodificarReduzido(f, larguraAlvoPx) ?: return null
        if (memoria.size > 60) memoria.clear()
        memoria[produtoId] = bmp
        return bmp
    }

    fun revalidar(ctx: Context, produtoId: String) {
        val novo = Integra.baixarImagem(ctx, produtoId, arquivo(ctx, produtoId), etag(ctx, produtoId))
        if (novo == null || novo == etag(ctx, produtoId)) return
        salvarEtag(ctx, produtoId, novo)
        memoria.remove(produtoId)
    }

    private fun decodificarReduzido(f: File, larguraAlvoPx: Int): Bitmap? = try {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(f.absolutePath, bounds)
        var largura = bounds.outWidth
        var amostra = 1
        while (largura / 2 >= larguraAlvoPx && amostra < 16) {
            largura /= 2
            amostra *= 2
        }
        BitmapFactory.decodeFile(f.absolutePath, BitmapFactory.Options().apply { inSampleSize = amostra })
    } catch (_: Throwable) {
        null
    }
}
