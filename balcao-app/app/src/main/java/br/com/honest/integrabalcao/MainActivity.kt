package br.com.honest.integrabalcao

import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.RadioGroup
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** Tela "Ajustes": pareamento, token e os testes de diagnostico do deep link. */
class MainActivity : AppCompatActivity() {
    private val io: ExecutorService = Executors.newSingleThreadExecutor()
    private lateinit var campoCodigo: EditText
    private lateinit var campoToken: EditText
    private lateinit var campoValor: EditText
    private lateinit var opcoesPagamento: RadioGroup
    private lateinit var status: TextView
    private lateinit var resumoUltimaVenda: TextView
    private var credenciais: Integra.CredenciaisCielo? = null
    private var pendentes: List<Integra.Pendente> = emptyList()

    private fun itensParaCielo(itens: JSONArray): JSONArray = itens

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        campoCodigo = findViewById(R.id.campoCodigo)
        campoToken = findViewById(R.id.campoToken)
        campoValor = findViewById(R.id.campoValor)
        opcoesPagamento = findViewById(R.id.opcoesPagamento)
        status = findViewById(R.id.status)
        resumoUltimaVenda = findViewById(R.id.ultimaVenda)
        findViewById<TextView>(R.id.versao).text = "versão " + Config.versao(this)
        campoToken.setText(Config.deviceToken(this))

        findViewById<Button>(R.id.btnParear).setOnClickListener { parear() }
        findViewById<Button>(R.id.btnSalvarToken).setOnClickListener {
            Config.salvarDeviceToken(this, campoToken.text.toString())
            carregarCredenciais()
        }
        findViewById<Button>(R.id.btnCobrarValorLivre).setOnClickListener { cobrarValorLivre() }
        findViewById<Button>(R.id.btnBuscarFila).setOnClickListener { buscarFila() }
        findViewById<Button>(R.id.btnCobrarPrimeiro).setOnClickListener { cobrarPrimeiroDaFila() }
        findViewById<Button>(R.id.btnImprimir).setOnClickListener { imprimirComprovante() }
        findViewById<Button>(R.id.btnCancelar).setOnClickListener { confirmarCancelamento() }

        if (Config.deviceToken(this).isNotBlank()) carregarCredenciais()
    }

    override fun onResume() {
        super.onResume()
        atualizarUltimaVenda()
    }

    private fun mostrar(texto: String) {
        runOnUiThread { status.text = texto }
    }

    private fun agora(): String = SimpleDateFormat("dd/MM/yyyy HH:mm", Locale("pt", "BR")).format(Date())

    private fun atualizarUltimaVenda() {
        val v = Config.ultimaVenda(this)
        resumoUltimaVenda.text = if (v == null) "Nenhuma venda neste aparelho ainda." else {
            val valor = v.optInt("paidAmount", 0) / 100.0
            listOfNotNull(
                if (v.optBoolean("estornado", false)) String.format("↩️ ESTORNADA — R$ %.2f", valor)
                else String.format("R$ %.2f", valor),
                v.optString("reference", "").takeIf { it.isNotBlank() }?.let { "Pedido: $it" },
                v.optString("cieloCode", "").takeIf { it.isNotBlank() }?.let { "NSU: $it" },
                v.optString("dataHora", "").takeIf { it.isNotBlank() }?.let { "Em: $it" },
                v.optString("dataHoraEstorno", "").takeIf { it.isNotBlank() }?.let { "Estorno: $it" },
            ).joinToString("\n")
        }
    }

    private fun parear() {
        val codigo = campoCodigo.text.toString().trim().uppercase(Locale.ROOT)
        if (codigo.length < 6) {
            mostrar("Digite o codigo de 8 caracteres gerado no INTEGRA.")
            return
        }
        mostrar("Pareando aparelho…")
        io.execute {
            try {
                val token = Integra.parear(this, codigo)
                Config.salvarDeviceToken(this, token)
                runOnUiThread {
                    campoToken.setText(token)
                    campoCodigo.setText("")
                }
                credenciais = Integra.credenciais(this)
                mostrar("Aparelho pareado. Credenciais OK, pronto para cobrar.")
            } catch (e: Exception) {
                mostrar("Falha no pareamento:\n${e.message}")
            }
        }
    }

    private fun carregarCredenciais() {
        mostrar("Buscando credenciais no INTEGRA…")
        io.execute {
            try {
                credenciais = Integra.credenciais(this)
                mostrar("Credenciais OK. Pronto para cobrar.")
            } catch (e: Exception) {
                credenciais = null
                mostrar("Falha ao buscar credenciais:\n${e.message}")
            }
        }
    }

    private fun valorEmCentavos(): Int? {
        val s = campoValor.text.toString().trim().replace(".", "").replace(",", "")
        if (s.isEmpty() || !s.all { it.isDigit() }) return null
        return s.toIntOrNull()?.takeIf { it > 0 }
    }

    private fun paymentCode(): String = when (opcoesPagamento.checkedRadioButtonId) {
        R.id.opCredito -> CieloDeepLink.Pagamento.CREDITO_AVISTA
        R.id.opPix -> CieloDeepLink.Pagamento.PIX
        else -> CieloDeepLink.Pagamento.DEBITO_AVISTA
    }

    private fun cobrarValorLivre() {
        val cred = credenciais ?: run { mostrar("Sem credenciais. Salve o token primeiro."); return }
        val valor = valorEmCentavos() ?: run { mostrar("Valor invalido. Digite em centavos, ex.: 100 = R$ 1,00."); return }
        Config.marcarPedidoEmCurso(this, null)
        Config.marcarOperacao(this, Config.OP_PAGAMENTO)
        mostrar("Enviando R$ " + String.format("%.2f", valor / 100.0) + " para a maquininha…")
        try {
            CieloDeepLink.cobrar(this, cred, valor, paymentCode(), "TESTE-BALCAO")
        } catch (e: Exception) {
            mostrar("Nao consegui abrir o app de pagamento.\nVerifique o <queries> no manifest.\n${e.message}")
        }
    }

    private fun buscarFila() {
        mostrar("Buscando pedidos pendentes…")
        io.execute {
            try {
                pendentes = Integra.pedidosPendentes(this)
                mostrar(
                    if (pendentes.isEmpty()) {
                        "Nenhum pedido AGUARDANDO na fila.\nSe você acabou de enfileirar um: uma cobrança recusada marca o pedido como FALHOU e ele sai da fila. Confira o pedido no INTEGRA."
                    } else {
                        "Pendentes: ${pendentes.size}\n" + pendentes.take(5).joinToString("\n") {
                            "• ${it.reference} — R$ " + String.format("%.2f", it.valorCentavos / 100.0)
                        }
                    },
                )
            } catch (e: Exception) {
                mostrar("Falha ao buscar fila:\n${e.message}")
            }
        }
    }

    private fun cobrarPrimeiroDaFila() {
        val cred = credenciais ?: run { mostrar("Sem credenciais. Salve o token primeiro."); return }
        val p = pendentes.firstOrNull() ?: run { mostrar("Fila vazia. Toque em Buscar fila."); return }
        Config.marcarPedidoEmCurso(this, p.id)
        Config.marcarOperacao(this, Config.OP_PAGAMENTO)
        mostrar("Cobrando ${p.reference} — R$ " + String.format("%.2f", p.valorCentavos / 100.0) + "…")
        try {
            CieloDeepLink.cobrar(
                this, cred, p.valorCentavos, paymentCode(), p.reference,
                if (p.itens.length() > 0) itensParaCielo(p.itens) else null,
            )
        } catch (e: Exception) {
            mostrar("Nao consegui abrir o app de pagamento.\n${e.message}")
        }
    }

    private fun imprimirComprovante() {
        val venda = Config.ultimaVenda(this) ?: run { mostrar("Nao ha venda para imprimir neste aparelho."); return }
        val texto = Comprovante.paraUltimaVenda(venda, Config.versao(this), agora(), Config.itensDaVenda(this))
        mostrar("Enviando comprovante para a impressora…")
        try {
            CieloDeepLink.imprimirTexto(this, texto)
        } catch (e: Exception) {
            mostrar("Nao consegui abrir a impressao.\n${e.message}")
        }
    }

    private fun confirmarCancelamento() {
        val cred = credenciais ?: run { mostrar("Sem credenciais. Salve o token primeiro."); return }
        val venda = Config.ultimaVenda(this) ?: run { mostrar("Nao ha venda para cancelar neste aparelho."); return }
        if (venda.optBoolean("estornado", false)) {
            mostrar("Esta venda ja foi estornada em " + venda.optString("dataHoraEstorno", "-") + ".")
            return
        }
        if (venda.optString("orderId", "").isBlank()) {
            mostrar("A ultima venda nao tem orderId da Cielo. Cancele pelo menu da maquininha.")
            return
        }
        val valor = venda.optInt("paidAmount", 0)
        val ref = venda.optString("reference", "").takeIf { it.isNotBlank() } ?: "sem referencia"
        AlertDialog.Builder(this)
            .setTitle("Cancelar venda?")
            .setMessage(String.format("Estornar R$ %.2f do pedido %s?\n\nO valor volta para o cliente. Esta acao nao tem volta.", valor / 100.0, ref))
            .setNegativeButton("Nao") { d, _ -> d.dismiss() }
            .setPositiveButton("Sim, cancelar") { d, _ -> d.dismiss(); cancelar(cred, venda) }
            .show()
    }

    private fun cancelar(cred: Integra.CredenciaisCielo, venda: JSONObject) {
        Config.marcarPedidoEmCurso(this, venda.optString("pedidoId", "").takeIf { it.isNotBlank() })
        Config.marcarOperacao(this, Config.OP_CANCELAMENTO)
        mostrar("Enviando cancelamento para a maquininha…")
        try {
            CieloDeepLink.cancelar(
                this, cred,
                venda.optString("orderId", ""),
                venda.optString("cieloCode", ""),
                venda.optString("authCode", ""),
                venda.optInt("paidAmount", 0),
            )
        } catch (e: Exception) {
            Config.marcarOperacao(this, Config.OP_PAGAMENTO)
            mostrar("Nao consegui abrir o cancelamento.\n${e.message}")
        }
    }

    override fun onDestroy() {
        io.shutdown()
        super.onDestroy()
    }
}
