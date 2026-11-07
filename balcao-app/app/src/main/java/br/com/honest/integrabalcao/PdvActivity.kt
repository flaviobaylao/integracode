package br.com.honest.integrabalcao

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.RadioGroup
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** Tela principal do balcao: grade de produtos, carrinho e cobranca. */
class PdvActivity : AppCompatActivity() {
    private val io: ExecutorService = Executors.newFixedThreadPool(3)
    private lateinit var status: TextView
    private lateinit var total: TextView
    private lateinit var resumo: TextView
    private lateinit var grade: RecyclerView
    private lateinit var btnVarejo: Button
    private lateinit var btnAtacado: Button
    private lateinit var btnCliente: Button
    private lateinit var btnVendedor: Button
    private lateinit var formaPagamento: RadioGroup

    private var credenciais: Integra.CredenciaisCielo? = null
    private var catalogo: List<Integra.Produto> = emptyList()
    private var vendedores: List<Integra.Vendedor> = emptyList()
    private var atacadoAPartirDe = 20000
    private var sugestaoAtacadoFeita = false
    private val adapter = ProdutoAdapter()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_pdv)
        status = findViewById(R.id.status)
        total = findViewById(R.id.total)
        resumo = findViewById(R.id.resumo)
        grade = findViewById(R.id.grade)
        btnVarejo = findViewById(R.id.btnVarejo)
        btnAtacado = findViewById(R.id.btnAtacado)
        btnCliente = findViewById(R.id.btnCliente)
        btnVendedor = findViewById(R.id.btnVendedor)
        formaPagamento = findViewById(R.id.formaPagamento)
        findViewById<TextView>(R.id.versao).text = "versão " + Config.versao(this)

        grade.layoutManager = GridLayoutManager(this, 2)
        grade.adapter = adapter

        btnVarejo.setOnClickListener { trocarTabela(Carrinho.VAREJO) }
        btnAtacado.setOnClickListener { trocarTabela(Carrinho.ATACADO) }
        btnCliente.setOnClickListener { escolherCliente() }
        btnVendedor.setOnClickListener { escolherVendedor(null) }
        findViewById<Button>(R.id.btnConfig).setOnClickListener { startActivity(Intent(this, MainActivity::class.java)) }
        findViewById<Button>(R.id.btnLimpar).setOnClickListener { limparCarrinho() }
        findViewById<Button>(R.id.btnCobrar).setOnClickListener { cobrar() }
        findViewById<Button>(R.id.btnImprimirPdv).setOnClickListener { imprimirUltima() }
        findViewById<Button>(R.id.btnCancelarVenda).setOnClickListener { confirmarCancelamento() }
        pintarTabela()
        pintarVendedor()
    }

    override fun onResume() {
        super.onResume()
        carregarTudo()
        atualizarRodape()
        atualizarBarraUltimaVenda()
    }

    private fun atualizarBarraUltimaVenda() {
        val venda = Config.ultimaVenda(this)
        val barra = findViewById<LinearLayout>(R.id.barraUltimaVenda)
        if (venda == null) {
            barra.visibility = View.GONE
            return
        }
        barra.visibility = View.VISIBLE
        val valor = Dinheiro.rs(venda.optInt("paidAmount", 0))
        val ref = venda.optString("reference", "").takeIf { it.isNotBlank() } ?: "—"
        val estornada = venda.optBoolean("estornado", false)
        findViewById<TextView>(R.id.txtUltimaVenda).text =
            if (estornada) "Última: $valor · $ref · ESTORNADA" else "Última: $valor · $ref"
        findViewById<Button>(R.id.btnCancelarVenda).visibility = if (estornada) View.GONE else View.VISIBLE
    }

    private fun imprimirUltima() {
        val venda = Config.ultimaVenda(this) ?: run { mostrar("Não há venda para imprimir."); return }
        val texto = Comprovante.paraUltimaVenda(venda, Config.versao(this), agora(), Config.itensDaVenda(this))
        Config.marcarOperacao(this, Config.OP_PAGAMENTO)
        try {
            CieloDeepLink.imprimirTexto(this, texto)
        } catch (e: Exception) {
            mostrar("Não consegui imprimir.\n${e.message}")
        }
    }

    private fun confirmarCancelamento() {
        val cred = credenciais ?: run { mostrar("Sem credenciais. Toque em Ajustes."); return }
        val venda = Config.ultimaVenda(this) ?: run { mostrar("Não há venda para cancelar."); return }
        if (venda.optBoolean("estornado", false)) {
            mostrar("Esta venda já foi estornada em " + venda.optString("dataHoraEstorno", "-") + ".")
            return
        }
        val orderId = venda.optString("orderId", "")
        if (orderId.isBlank()) {
            mostrar("A última venda não tem orderId da Cielo. Cancele pelo menu da maquininha.")
            return
        }
        val valor = venda.optInt("paidAmount", 0)
        val ref = venda.optString("reference", "").takeIf { it.isNotBlank() } ?: "sem referência"
        val itens = Config.itensDaVenda(this)?.optJSONArray("itens")
        val listaItens = if (itens != null && itens.length() > 0) {
            (0 until itens.length()).joinToString("\n") {
                val j = itens.getJSONObject(it)
                "• ${j.optInt("qtd")}x " + Nomes.curto(j.optString("nome"))
            } + "\n\n"
        } else ""
        AlertDialog.Builder(this)
            .setTitle("Cancelar venda?")
            .setMessage(listaItens + "Estornar ${Dinheiro.rs(valor)} do pedido $ref?\n\nO valor volta para o cliente e o título é cancelado no financeiro. Esta ação não tem volta.")
            .setNegativeButton("Não", null)
            .setPositiveButton("Sim, cancelar") { d, _ ->
                d.dismiss()
                Config.marcarPedidoEmCurso(this, venda.optString("pedidoId", "").takeIf { it.isNotBlank() })
                Config.marcarOperacao(this, Config.OP_CANCELAMENTO)
                mostrar("Enviando cancelamento para a maquininha…")
                try {
                    CieloDeepLink.cancelar(
                        this, cred, orderId,
                        venda.optString("cieloCode", ""),
                        venda.optString("authCode", ""),
                        valor,
                    )
                } catch (e: Exception) {
                    mostrar("Não consegui abrir o cancelamento.\n${e.message}")
                }
            }
            .show()
    }

    private fun mostrar(texto: String) {
        runOnUiThread { status.text = texto }
    }

    private fun agora(): String = SimpleDateFormat("dd/MM/yyyy HH:mm", Locale("pt", "BR")).format(Date())

    private fun carregarTudo() {
        if (Config.deviceToken(this).isBlank()) {
            mostrar("Aparelho não pareado. Toque em Ajustes e informe o código do INTEGRA.")
            return
        }
        mostrar("Carregando catálogo…")
        io.execute {
            try {
                val cred = Integra.credenciais(this)
                val cat = Integra.catalogo(this)
                credenciais = cred
                catalogo = cat.produtos
                atacadoAPartirDe = cat.atacadoAPartirDeCentavos
                runOnUiThread {
                    adapter.notifyDataSetChanged()
                    atualizarRodape()
                }
                val semAtacado = cat.produtos.count { !it.disponivelNa(Carrinho.ATACADO) }
                mostrar("Pronto. ${cat.produtos.size} produtos." + if (semAtacado > 0) " ($semAtacado sem preço de atacado)" else "")
                precarregarFotos()
            } catch (e: Exception) {
                mostrar("Falha ao carregar:\n${e.message}")
            }
            // Lista de vendedores em separado: se falhar, a grade continua
            // funcionando e a escolha tenta de novo na hora de cobrar.
            try {
                vendedores = Integra.vendedores(this)
            } catch (_: Exception) { }
        }
    }

    private fun precarregarFotos() {
        val largura = (resources.displayMetrics.density * 160).toInt()
        for (p in catalogo) {
            if (!p.temImagem) continue
            io.execute {
                if (FotoCache.carregar(this, p.id, largura) != null) {
                    runOnUiThread {
                        val i = catalogo.indexOfFirst { it.id == p.id }
                        if (i >= 0) adapter.notifyItemChanged(i)
                    }
                }
            }
        }
    }

    private fun trocarTabela(nova: String) {
        Carrinho.trocarTabela(nova)
        pintarTabela()
        val bloqueados = Carrinho.itensBloqueados(catalogo)
        if (bloqueados.isNotEmpty()) {
            AlertDialog.Builder(this)
                .setTitle("Sem preço de $nova")
                .setMessage(bloqueados.joinToString("\n") { "• ${it.nome}" } + "\n\nEsses itens não têm preço de $nova cadastrado. Remova-os do carrinho ou volte para a outra tabela.")
                .setPositiveButton("Entendi", null)
                .show()
        }
        adapter.notifyDataSetChanged()
        atualizarRodape()
    }

    private fun pintarTabela() {
        val atacado = Carrinho.tabela == Carrinho.ATACADO
        btnVarejo.alpha = if (atacado) 0.45f else 1f
        btnAtacado.alpha = if (atacado) 1f else 0.45f
    }

    /** O botao denuncia o estado: vermelho sem vendedor, verde com. */
    private fun pintarVendedor() {
        val nome = Carrinho.vendedorNome
        if (nome == null) {
            btnVendedor.text = "VENDEDOR: toque para escolher"
            btnVendedor.setTextColor(Color.parseColor("#B00020"))
        } else {
            btnVendedor.text = "VENDEDOR: $nome"
            btnVendedor.setTextColor(Color.parseColor("#1B7F3B"))
        }
    }

    /**
     * Escolha do vendedor. Obrigatoria para cobrar e esquecida ao fim de cada
     * venda (regra do Flavio, nov/2026). `depois` e o que continua apos a
     * escolha — a propria cobranca, quando o operador tocou em COBRAR sem
     * ter apontado ninguem.
     */
    private fun escolherVendedor(depois: (() -> Unit)?) {
        if (vendedores.isEmpty()) {
            mostrar("Buscando vendedores…")
            io.execute {
                try {
                    vendedores = Integra.vendedores(this)
                    runOnUiThread { escolherVendedor(depois) }
                } catch (e: Exception) {
                    mostrar("Não consegui buscar os vendedores:\n${e.message}")
                }
            }
            return
        }
        val nomes = vendedores.map { it.nome }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle("Quem fez esta venda?")
            .setItems(nomes) { _, i ->
                val v = vendedores[i]
                Carrinho.apontarVendedor(v.id, v.nome)
                pintarVendedor()
                mostrar("Vendedor: ${v.nome}")
                depois?.invoke()
            }
            .setNegativeButton("Cancelar", null)
            .show()
    }

    private fun escolherCliente() {
        val campo = EditText(this)
        campo.hint = "nome, CPF ou CNPJ"
        val box = LinearLayout(this)
        box.orientation = LinearLayout.VERTICAL
        box.setPadding(48, 24, 48, 0)
        box.addView(campo)
        AlertDialog.Builder(this)
            .setTitle("Identificar cliente")
            .setMessage("Opcional. Sem cliente, a venda entra como avulsa.")
            .setView(box)
            .setPositiveButton("Buscar") { _, _ -> buscarCliente(campo.text.toString().trim()) }
            .setNeutralButton("Venda avulsa") { _, _ ->
                Carrinho.identificarCliente(null, null)
                atualizarRodape()
                mostrar("Venda avulsa.")
            }
            .setNegativeButton("Cancelar", null)
            .show()
    }

    private fun buscarCliente(termo: String) {
        if (termo.length < 3) {
            mostrar("Digite ao menos 3 caracteres.")
            return
        }
        mostrar("Buscando cliente…")
        io.execute {
            try {
                val achados = Integra.buscarClientes(this, termo)
                runOnUiThread {
                    if (achados.isEmpty()) {
                        mostrar("Nenhum cliente para \"$termo\".")
                        return@runOnUiThread
                    }
                    val rotulos = achados.map { it.nome + (it.documento?.let { d -> "\n$d" } ?: "") }.toTypedArray()
                    AlertDialog.Builder(this)
                        .setTitle("Selecione")
                        .setItems(rotulos) { _, i ->
                            Carrinho.identificarCliente(achados[i].id, achados[i].nome)
                            atualizarRodape()
                            mostrar("Cliente: ${achados[i].nome}")
                        }
                        .setNegativeButton("Cancelar", null)
                        .show()
                }
            } catch (e: Exception) {
                mostrar("Falha na busca:\n${e.message}")
            }
        }
    }

    private fun limparCarrinho() {
        if (Carrinho.vazio()) return
        AlertDialog.Builder(this)
            .setTitle("Limpar carrinho?")
            .setMessage("${Carrinho.totalItens()} itens serão removidos.")
            .setPositiveButton("Limpar") { _, _ ->
                Carrinho.limpar()
                adapter.notifyDataSetChanged()
                atualizarRodape()
                pintarVendedor()
                mostrar("Carrinho limpo.")
            }
            .setNegativeButton("Voltar", null)
            .show()
    }

    fun atualizarRodape() {
        val centavos = Carrinho.totalCentavos(catalogo)
        total.text = Dinheiro.rs(centavos)
        val cliente = Carrinho.clienteNome?.let { " · $it" } ?: " · avulsa"
        val tabela = if (Carrinho.tabela == Carrinho.ATACADO) "ATACADO" else "VAREJO"
        resumo.text = "${Carrinho.totalItens()} itens · $tabela$cliente"
        if (sugestaoAtacadoFeita || Carrinho.tabela != Carrinho.VAREJO || centavos < atacadoAPartirDe) return
        sugestaoAtacadoFeita = true
        AlertDialog.Builder(this)
            .setTitle("Passou de ${Dinheiro.rs(atacadoAPartirDe)}")
            .setMessage("No cadastro, compras a partir desse valor usam a tabela de ATACADO. Trocar agora?")
            .setPositiveButton("Usar atacado") { _, _ -> trocarTabela(Carrinho.ATACADO) }
            .setNegativeButton("Manter varejo", null)
            .show()
    }

    private fun paymentCode(): String = when (formaPagamento.checkedRadioButtonId) {
        R.id.opCredito -> CieloDeepLink.Pagamento.CREDITO_AVISTA
        R.id.opPix -> CieloDeepLink.Pagamento.PIX
        else -> CieloDeepLink.Pagamento.DEBITO_AVISTA
    }

    private fun cobrar() {
        val cred = credenciais ?: run { mostrar("Sem credenciais. Toque em Ajustes."); return }
        if (Carrinho.vazio()) {
            mostrar("Carrinho vazio.")
            return
        }
        val bloqueados = Carrinho.itensBloqueados(catalogo)
        if (bloqueados.isNotEmpty()) {
            mostrar("Remova os itens sem preço de ${Carrinho.tabela}:\n" + bloqueados.joinToString("\n") { "• ${it.nome}" })
            return
        }
        // Trava: sem vendedor nao cobra. Abre a escolha e volta para ca.
        if (Carrinho.vendedorId == null) {
            mostrar("Escolha o vendedor desta venda.")
            escolherVendedor { cobrar() }
            return
        }
        val linhas = Carrinho.linhasComprovante(catalogo)
        val vendedorId = Carrinho.vendedorId
        val vendedorNome = Carrinho.vendedorNome
        mostrar("Fechando venda no INTEGRA…")
        io.execute {
            try {
                val pedido = Integra.criarVenda(this, Carrinho.paraEnvio(), Carrinho.tabela, Carrinho.clienteId, vendedorId)
                Config.marcarPedidoEmCurso(this, pedido.id)
                Config.marcarOperacao(this, Config.OP_PAGAMENTO)
                Config.salvarItensDaVenda(this, linhas, Carrinho.tabela, Carrinho.clienteNome, vendedorNome)
                Config.salvarForma(this, paymentCode())
                runOnUiThread {
                    mostrar("Cobrando ${Dinheiro.rs(pedido.valorCentavos)} — ${pedido.reference}…")
                    try {
                        CieloDeepLink.cobrar(this, cred, pedido.valorCentavos, paymentCode(), pedido.reference, pedido.itens)
                        // Venda despachada: carrinho, cliente E vendedor zeram.
                        // A proxima venda aponta o vendedor de novo.
                        Carrinho.limpar()
                        sugestaoAtacadoFeita = false
                        adapter.notifyDataSetChanged()
                        atualizarRodape()
                        pintarVendedor()
                    } catch (e: Exception) {
                        mostrar("Não consegui abrir o app de pagamento.\n${e.message}")
                    }
                }
            } catch (e: Exception) {
                mostrar("Venda recusada pelo INTEGRA:\n${e.message}")
            }
        }
    }

    inner class ProdutoAdapter : RecyclerView.Adapter<ProdutoAdapter.Celula>() {
        inner class Celula(v: View) : RecyclerView.ViewHolder(v) {
            val foto: ImageView = v.findViewById(R.id.foto)
            val nome: TextView = v.findViewById(R.id.nome)
            val preco: TextView = v.findViewById(R.id.preco)
            val semPreco: TextView = v.findViewById(R.id.semPreco)
            val qtd: TextView = v.findViewById(R.id.qtd)
            val btnMais: Button = v.findViewById(R.id.btnMais)
            val btnMenos: Button = v.findViewById(R.id.btnMenos)
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Celula =
            Celula(LayoutInflater.from(parent.context).inflate(R.layout.item_produto, parent, false))

        override fun getItemCount(): Int = catalogo.size

        override fun onBindViewHolder(h: Celula, pos: Int) {
            val p = catalogo[pos]
            val disponivel = p.disponivelNa(Carrinho.tabela)
            val preco = p.precoNa(Carrinho.tabela)
            h.nome.text = Nomes.curto(p.nome)
            h.qtd.text = Carrinho.quantidade(p.id).toString()
            if (disponivel) {
                h.preco.text = Dinheiro.rs(preco)
                h.preco.visibility = View.VISIBLE
                h.semPreco.visibility = View.GONE
            } else {
                h.preco.visibility = View.GONE
                h.semPreco.visibility = View.VISIBLE
                h.semPreco.text = "sem preço de ${Carrinho.tabela}"
            }
            h.itemView.alpha = if (disponivel) 1f else 0.4f
            h.btnMais.isEnabled = disponivel
            h.btnMenos.isEnabled = disponivel
            h.foto.setImageBitmap(FotoCache.emMemoria(p.id))
            h.btnMais.setOnClickListener {
                Carrinho.somar(p.id, 1)
                h.qtd.text = Carrinho.quantidade(p.id).toString()
                atualizarRodape()
            }
            h.btnMenos.setOnClickListener {
                Carrinho.somar(p.id, -1)
                h.qtd.text = Carrinho.quantidade(p.id).toString()
                atualizarRodape()
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        io.shutdown()
    }
}
