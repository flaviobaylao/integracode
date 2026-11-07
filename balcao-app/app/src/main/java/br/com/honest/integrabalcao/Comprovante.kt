package br.com.honest.integrabalcao

import org.json.JSONObject
import java.util.Locale

/** Textos de 32 colunas para a impressora termica da LIO. */
object Comprovante {
    private const val COLUNAS = 32

    private fun centro(t: String): String =
        if (t.length >= COLUNAS) t.take(COLUNAS) else " ".repeat((COLUNAS - t.length) / 2) + t

    private fun linha(rotulo: String, valor: String): String {
        val espaco = COLUNAS - rotulo.length - valor.length
        return if (espaco < 1) "$rotulo $valor" else rotulo + " ".repeat(espaco) + valor
    }

    private fun separador(): String = "-".repeat(COLUNAS)

    private fun reais(centavos: Int): String = "R$ " + String.format("%.2f", centavos / 100.0)

    private fun linhaItem(qtd: Int, unit: Int): String {
        val esq = "  $qtd x " + String.format("%.2f", unit / 100.0)
        val dir = String.format("%.2f", (qtd * unit) / 100.0)
        return esq + " ".repeat(Math.max(COLUNAS - esq.length - dir.length, 1)) + dir
    }

    private fun blocoItens(j: JSONObject?): List<String> {
        val arr = j?.optJSONArray("itens") ?: return emptyList()
        if (arr.length() == 0) return emptyList()
        val l = ArrayList<String>()
        l.add(separador())
        val tabela = j.optString("tabela", "")
        if (tabela.isNotBlank()) l.add(centro("TABELA: " + tabela.uppercase(Locale.ROOT)))
        j.optString("cliente", "").takeIf { it.isNotBlank() }?.let { l.add(linha("Cliente", it.take(20))) }
        j.optString("vendedor", "").takeIf { it.isNotBlank() }?.let { l.add(linha("Vendedor", it.take(19))) }
        if (tabela.isNotBlank() || j.has("cliente") || j.has("vendedor")) l.add(separador())
        var subtotal = 0
        for (i in 0 until arr.length()) {
            val it = arr.optJSONObject(i) ?: continue
            val qtd = it.optInt("qtd", 0)
            val unit = it.optInt("unit", 0)
            subtotal += qtd * unit
            l.addAll(Nomes.quebrar(it.optString("nome", "item"), COLUNAS))
            l.add(linhaItem(qtd, unit))
        }
        l.add(separador())
        l.add(linha("Itens", arr.length().toString()))
        l.add(linha("Subtotal", reais(subtotal)))
        return l
    }

    fun montar(d: JSONObject, via: String, versaoApp: String, dataHora: String, itens: JSONObject? = null): String {
        val l = ArrayList<String>()
        l.add(centro("HONEST SUCOS"))
        l.add(centro("CNPJ 28.295.493/0001-53"))
        l.add(separador())
        l.add(centro("COMPROVANTE DE PAGAMENTO"))
        l.add(centro("VIA $via"))
        l.add(separador())
        l.add(linha("Data", dataHora))
        d.optString("reference", "").takeIf { it.isNotBlank() }?.let { l.add(linha("Pedido", it.take(20))) }
        l.addAll(blocoItens(itens))
        val forma = if (d.optString("statusCode", "") == "0") "PIX"
        else d.optString("brand", "").takeIf { it.isNotBlank() } ?: "CARTAO"
        l.add(linha("Forma", forma.take(16)))
        d.optString("mask", "").takeIf { it.isNotBlank() }?.let { l.add(linha("Cartao", it.take(16))) }
        val parcelas = d.optInt("installments", 0)
        if (parcelas > 1) l.add(linha("Parcelas", parcelas.toString()))
        d.optString("cieloCode", "").takeIf { it.isNotBlank() }?.let { l.add(linha("NSU", it.take(16))) }
        d.optString("authCode", "").takeIf { it.isNotBlank() }?.let { l.add(linha("Autorizacao", it.take(12))) }
        d.optString("terminal", "").takeIf { it.isNotBlank() }?.let { l.add(linha("Terminal", it.take(14))) }
        l.add(separador())
        l.add(linha("TOTAL", reais(d.optInt("paidAmount", 0))))
        l.add(separador())
        l.add(centro("Obrigado pela preferencia"))
        l.add("")
        l.add(centro("INTEGRA Balcao v$versaoApp"))
        l.add("")
        l.add("")
        return l.joinToString("\n")
    }

    fun paraUltimaVenda(venda: JSONObject, versaoApp: String, agora: String, itens: JSONObject? = null): String {
        if (venda.optBoolean("estornado", false)) {
            val quando = venda.optString("dataHoraEstorno", "").takeIf { it.isNotBlank() } ?: agora
            return montarCancelamento(venda, versaoApp, quando)
        }
        val quando = venda.optString("dataHora", "").takeIf { it.isNotBlank() } ?: agora
        return montar(venda, "CLIENTE", versaoApp, quando, itens)
    }

    private fun quebrarBruto(t: String): List<String> = t.chunked(COLUNAS).map { centro(it.trim()) }

    private fun chaveFormatada(chave: String): List<String> {
        val digitos = chave.filter { it.isDigit() }
        if (digitos.length != 44) return if (digitos.isBlank()) emptyList() else quebrarBruto(digitos)
        return quebrarBruto(digitos.chunked(4).joinToString(" "))
    }

    fun montarDanfeNfce(danfe: JSONObject, itens: JSONObject?, venda: JSONObject?): String {
        val l = ArrayList<String>()
        val emit = danfe.optJSONObject("emitente")
        l.add(centro(emit?.optString("nome", "HONEST SUCOS") ?: "HONEST SUCOS"))
        emit?.optString("cnpj", "")?.takeIf { it.isNotBlank() }?.let { l.add(centro("CNPJ $it")) }
        val cidadeUf = listOfNotNull(
            emit?.optString("cidade", "")?.takeIf { it.isNotBlank() },
            emit?.optString("uf", "")?.takeIf { it.isNotBlank() },
        ).joinToString("/")
        if (cidadeUf.isNotBlank()) l.add(centro(cidadeUf))
        l.add(separador())
        l.add(centro("DANFE NFC-e"))
        l.add(centro("Documento Auxiliar da"))
        l.add(centro("Nota Fiscal de Consumidor"))
        l.add(centro("Eletronica"))
        l.add(separador())
        l.add(centro("NAO PERMITE APROVEITAMENTO"))
        l.add(centro("DE CREDITO DE ICMS"))
        l.add(separador())

        var total = 0
        val arr = itens?.optJSONArray("itens")
        if (arr != null) {
            var qtdItens = 0
            for (i in 0 until arr.length()) {
                val it = arr.optJSONObject(i) ?: continue
                val qtd = it.optInt("qtd", 0)
                val unit = it.optInt("unit", 0)
                total += qtd * unit
                qtdItens++
                l.addAll(Nomes.quebrar(it.optString("nome", "item"), COLUNAS))
                l.add(linhaItem(qtd, unit))
            }
            l.add(separador())
            l.add(linha("Qtd. total de itens", qtdItens.toString()))
        }
        venda?.optInt("paidAmount", 0)?.takeIf { it > 0 }?.let { total = it }
        l.add(linha("VALOR TOTAL", reais(total)))
        val forma = if (venda?.optString("statusCode", "") == "0") "PIX"
        else venda?.optString("brand", "")?.takeIf { it.isNotBlank() } ?: "CARTAO"
        l.add(linha("Forma de pagamento", forma.take(14)))
        l.add(linha("Valor pago", reais(total)))
        l.add(separador())
        l.add(centro("Consulte pela chave de acesso em"))
        danfe.optString("urlConsulta", "").takeIf { it.isNotBlank() }?.let { l.addAll(quebrarBruto(it)) }
        l.add("")
        l.add(centro("CHAVE DE ACESSO"))
        l.addAll(chaveFormatada(danfe.optString("chave", "")))
        l.add("")
        l.add(centro("CONSUMIDOR NAO IDENTIFICADO"))
        l.add(separador())
        l.add(linha("NFC-e n.", danfe.optString("numero", "")))
        l.add(linha("Serie", danfe.optString("serie", "")))
        danfe.optString("emitidaEm", "").takeIf { it.isNotBlank() }
            ?.let { l.add(linha("Emissao", it.take(19).replace("T", " "))) }
        l.add("")
        l.add(centro("Protocolo de autorizacao"))
        danfe.optString("protocolo", "").takeIf { it.isNotBlank() }?.let { l.add(centro(it)) }
        danfe.optString("autorizadaEm", "").takeIf { it.isNotBlank() }
            ?.let { l.add(centro(it.take(19).replace("T", " "))) }
        l.add(separador())
        l.add("")
        l.add("")
        return l.joinToString("\n")
    }

    fun montarCancelamento(d: JSONObject, versaoApp: String, dataHora: String): String {
        val l = ArrayList<String>()
        l.add(centro("HONEST SUCOS"))
        l.add(centro("CNPJ 28.295.493/0001-53"))
        l.add(separador())
        l.add(centro("*** CANCELAMENTO ***"))
        l.add(separador())
        l.add(linha("Data", dataHora))
        d.optString("reference", "").takeIf { it.isNotBlank() }?.let { l.add(linha("Pedido", it.take(20))) }
        d.optString("cieloCode", "").takeIf { it.isNotBlank() }?.let { l.add(linha("NSU orig.", it.take(16))) }
        d.optString("authCode", "").takeIf { it.isNotBlank() }?.let { l.add(linha("Autorizacao", it.take(12))) }
        l.add(separador())
        l.add(linha("VALOR ESTORNADO", reais(d.optInt("paidAmount", 0))))
        l.add(separador())
        l.add("")
        l.add(centro("INTEGRA Balcao v$versaoApp"))
        l.add("")
        l.add("")
        return l.joinToString("\n")
    }
}
