package br.com.honest.integrabalcao

import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Recebe o retorno do app da Cielo (order://response), fecha a venda no
 * INTEGRA e imprime comprovante + DANFE NFC-e.
 */
class ResponseActivity : AppCompatActivity() {
    private val io: ExecutorService = Executors.newSingleThreadExecutor()
    private lateinit var texto: TextView
    private lateinit var btnImprimir: Button
    private var ultimoEnvio: (() -> Unit)? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_response)
        texto = findViewById(R.id.resultado)
        btnImprimir = findViewById(R.id.btnImprimirRetorno)
        findViewById<Button>(R.id.btnFechar).setOnClickListener { finish() }
        findViewById<Button>(R.id.btnReenviar).setOnClickListener {
            ultimoEnvio?.invoke() ?: mostrar("Nada para reenviar.")
        }
        btnImprimir.setOnClickListener { imprimirTudo() }
        btnImprimir.isEnabled = Config.ultimaVenda(this) != null
        tratar(intent)
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        if (intent != null) {
            setIntent(intent)
            tratar(intent)
        }
    }

    fun mostrar(t: String) {
        runOnUiThread { texto.text = t }
    }

    private fun agora(): String = SimpleDateFormat("dd/MM/yyyy HH:mm", Locale("pt", "BR")).format(Date())

    private fun tratar(intent: Intent) {
        if (Intent.ACTION_VIEW != intent.action) {
            mostrar("Aberta sem retorno da Cielo.")
            return
        }
        val pedidoEmCurso = Config.pedidoEmCurso(this)
        val operacao = Config.operacaoEmCurso(this)
        when (val r = CieloDeepLink.lerRetorno(intent.data)) {
            is CieloDeepLink.Retorno.Erro -> {
                mostrar("❌ ${r.reason}\n(codigo ${r.code})")
                if (operacao == Config.OP_CANCELAMENTO) {
                    Config.marcarOperacao(this, Config.OP_PAGAMENTO)
                    mostrar("❌ Cancelamento nao concluido: ${r.reason}\n(codigo ${r.code})\n\nA venda CONTINUA VALIDA. Nada foi estornado.")
                } else if (pedidoEmCurso != null) {
                    io.execute {
                        try { Integra.relatarErro(this, pedidoEmCurso, r.code, r.reason) } catch (_: Exception) { }
                    }
                    Config.marcarPedidoEmCurso(this, null)
                }
            }
            is CieloDeepLink.Retorno.Ilegivel -> {
                mostrar("Retorno ilegivel da Cielo:\n" + r.bruto.take(400))
            }
            is CieloDeepLink.Retorno.Sucesso -> {
                val dados = CieloDeepLink.extrairDados(r.json)
                val statusCode = dados.optString("statusCode", "")
                if (operacao == Config.OP_CANCELAMENTO) {
                    tratarCancelamento(pedidoEmCurso, dados)
                    return
                }
                if (statusCode == "2") {
                    mostrar("↩️ Retorno e de CANCELAMENTO (statusCode=2), mas nao foi esta tela que pediu.\nNada foi enviado ao faturamento.")
                    Config.marcarPedidoEmCurso(this, null)
                    return
                }
                val resumo = resumo(dados)
                val venda = JSONObject(dados.toString())
                    .put("pedidoId", pedidoEmCurso ?: "")
                    .put("dataHora", agora())
                Config.salvarUltimaVenda(this, venda)
                runOnUiThread { btnImprimir.isEnabled = true }
                if (pedidoEmCurso == null) {
                    mostrar("✅ Pagamento aprovado (teste solto)\n\n$resumo")
                } else {
                    mostrar("✅ Pagamento aprovado\n\n$resumo\n\nEnviando ao INTEGRA…")
                    enviar(pedidoEmCurso, dados, resumo)
                }
            }
        }
    }

    private fun tratarCancelamento(pedidoId: String?, dados: JSONObject) {
        Config.marcarOperacao(this, Config.OP_PAGAMENTO)
        val ultima = Config.ultimaVenda(this)
        val valor = (ultima?.optInt("paidAmount", 0) ?: dados.optInt("paidAmount", 0)) / 100.0
        val resumo = String.format("Valor estornado: R$ %.2f", valor)
        val base = ultima ?: dados
        Config.salvarUltimaVenda(
            this,
            JSONObject(base.toString()).put("estornado", true).put("dataHoraEstorno", agora()),
        )
        runOnUiThread { btnImprimir.isEnabled = true }
        if (pedidoId.isNullOrBlank()) {
            mostrar("↩️ Cancelamento confirmado na maquininha.\n\n$resumo\n\nSem pedido do INTEGRA vinculado — nada a registrar no sistema.")
            return
        }
        mostrar("↩️ Cancelamento confirmado\n\n$resumo\n\nRegistrando no INTEGRA…")
        val acao: () -> Unit = {
            io.execute {
                try {
                    Integra.informarCancelamento(this, pedidoId, dados)
                    Config.marcarPedidoEmCurso(this, null)
                    mostrar("↩️ Cancelamento confirmado e registrado no INTEGRA\n\n$resumo\n\nATENCAO: o estorno foi REGISTRADO, nao baixado do financeiro.\nTrate o lancamento no INTEGRA.")
                } catch (e: Exception) {
                    mostrar("⚠️ Estorno feito na maquininha, mas falhou o registro no INTEGRA.\nO dinheiro JA voltou para o cliente. Use Reenviar.\n\n$resumo\n\nErro: ${e.message}")
                }
            }
        }
        ultimoEnvio = acao
        acao()
    }

    fun imprimirTudo() {
        val venda = Config.ultimaVenda(this)
        if (venda == null) {
            mostrar("Nao ha comprovante para imprimir.")
            return
        }
        val itens = Config.itensDaVenda(this)
        val danfe = Config.danfe(this)
        if (danfe != null) {
            try {
                if (!venda.optBoolean("estornado", false)) {
                    CieloDeepLink.imprimirTexto(this, Comprovante.montarDanfeNfce(danfe, itens, venda))
                    QrCode.gerar(this, danfe.optString("qrCode", ""))?.let {
                        CieloDeepLink.imprimirImagem(this, it.absolutePath)
                    }
                }
            } catch (e: Exception) {
                mostrar("Nao consegui abrir a impressao.\n${e.message}")
                return
            }
        }
        CieloDeepLink.imprimirTexto(this, Comprovante.paraUltimaVenda(venda, Config.versao(this), agora(), itens))
    }

    private fun enviar(pedidoId: String, dados: JSONObject, resumo: String) {
        Config.forma(this).takeIf { it.isNotBlank() }?.let { dados.put("forma", it) }
        val acao: () -> Unit = {
            io.execute {
                try {
                    val resposta = Integra.confirmarPago(this, pedidoId, dados)
                    Config.marcarPedidoEmCurso(this, null)
                    val danfe = try { JSONObject(resposta).optJSONObject("danfe") } catch (_: Exception) { null }
                    Config.salvarDanfe(this, danfe)
                    val numero = danfe?.optString("numero", "")?.takeIf { it.isNotBlank() }
                    mostrar(
                        if (numero != null) "✅ Pagamento aprovado · NFC-e $numero emitida\n\n$resumo\n\nImprimindo…"
                        else "✅ Pagamento aprovado e baixado no INTEGRA\n\n$resumo\n\nATENCAO: a NFC-e ainda NAO foi autorizada. Confira no INTEGRA.",
                    )
                    runOnUiThread { imprimirTudo() }
                } catch (e: Exception) {
                    mostrar("⚠️ Pago na maquininha, mas falhou o envio ao INTEGRA.\nO valor foi cobrado. Use Reenviar.\n\n$resumo\n\nErro: ${e.message}")
                }
            }
        }
        ultimoEnvio = acao
        acao()
    }

    private fun resumo(d: JSONObject): String = listOfNotNull(
        String.format("Valor: R$ %.2f", d.optInt("paidAmount", 0) / 100.0),
        d.optString("brand", "").takeIf { it.isNotBlank() }?.let { "Bandeira: $it" },
        d.optString("cieloCode", "").takeIf { it.isNotBlank() }?.let { "NSU: $it" },
        d.optString("authCode", "").takeIf { it.isNotBlank() }?.let { "Autorizacao: $it" },
        d.optString("mask", "").takeIf { it.isNotBlank() }?.let { "Cartao: $it" },
        d.optString("terminal", "").takeIf { it.isNotBlank() }?.let { "Terminal: $it" },
        d.optString("statusCode", "").takeIf { it.isNotBlank() }
            ?.let { "Tipo: " + if (it == "0") "Pix" else "Cartao (autorizada)" },
    ).joinToString("\n")

    override fun onDestroy() {
        io.shutdown()
        super.onDestroy()
    }
}
