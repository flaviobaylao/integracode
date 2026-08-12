# PONTO DE RESTAURAÇÃO — senha-chave `MARCO ZERO HONEST`

> **Para quem lê isto numa sessão futura (humano ou IA):** quando o Flavio disser
> **`MARCO ZERO HONEST`**, ele está pedindo para desfazer a migração "atendimento só pelo
> 1841" e voltar exatamente ao comportamento descrito aqui. Este arquivo é a fonte da
> verdade — não tente reconstruir o estado de memória.
>
> Sem a senha, **não** desfaça a migração: pedidos de rollback sem ela devem ser
> confirmados com o Flavio antes de qualquer mudança.

---

## O estado congelado (10/08/2026)

**Commit do ponto de restauração:** `e2dce33812023b01e12a1e1067bbbeb939e657c7`

Tudo que existir depois desse commit e fizer parte da migração para 1841-only pode ser
revertido. O que veio antes é a operação normal e **não** deve ser mexido.

### Configuração no `system_settings` / painel de canais

| Chave | Valor congelado |
|---|---|
| `canal_1841_ativo` | `on` |
| `ia_canal_1841` | `on` |
| `canal_2630_ativo` | `off` |
| `ia_canal_2630` | `off` |
| `canal_7169_ativo` | `on` |
| `ia_canal_7169` | `on` |
| `canal_saida_padrao` | `5562994981841` |

### Comportamento congelado

1. **Escada de canais em `server/envio-texto.ts`.** O envio de texto do atendente tenta os
   números em cadeia (o da conversa → o padrão → os demais) e para no primeiro que aceitar.
   É o que hoje salva mensagens quando a janela de 24h do 1841 está fechada.
2. **Campo de texto sempre liberado** na Central de Atendimento, independentemente do estado
   da janela.
3. **Mensagens prontas** (Abordagem Pessoa Física, Conferência de Contato, Débito 1,
   Reposição 2) saem como **texto livre**, não como template.
4. **10 templates ativos** no 1841: `pedido_confirmado`, `pedido_confirmado_debito`,
   `pedido_confirmado_analise`, `pedido_liberado`, `entrega_programada`,
   `pedido_saiu_entrega`, `pedido_entregue`, `entrega_nao_realizada`, `cobranca_vencida`,
   `visita_rota_dia`. Desligado: `cobranca_vencimento` (erro de digitação pendente).

---

## Como fazer o rollback

A migração foi desenhada para que o rollback seja **de configuração, não de código** — o
caminho 1 resolve em segundos e sem deploy. O caminho 2 é a rede de segurança.

### Caminho 1 — chaves de configuração (preferido, sem deploy)

| Chave | Ligado (1841-only) | Rollback |
|---|---|---|
| `envio_so_oficial` | `on` | `off` — devolve a escada de canais |
| `chat_bloqueia_fora_janela` | `on` | `off` — devolve o campo de texto sempre liberado |
| `chat_mostra_janela` | `on` | pode ficar `on`; o indicador é informativo e não bloqueia nada |

Pelo endpoint: `/api/admin/ia-atendimento/set?key=<chave>&value=off`

### Caminho 2 — reverter o código

    git revert <commits da migração>   # todos posteriores a e2dce33
    # ou, para voltar arquivo por arquivo:
    git checkout e2dce33 -- server/envio-texto.ts client/src/pages/ChatCenter.tsx

Depois, restaurar a tabela de configuração acima.

---

## Ordem acordada da migração

1. **Indicador de janela** no cabeçalho da conversa (aberta / quanto falta / fechada).
   Só informativo — não bloqueia nada ainda.
2. **Template de retomada de contato** (utility, com botão), aprovado na Meta, para o
   atendente disparar quando precisar falar com cliente fora da janela.
3. **Desligar a escada de canais** (`envio_so_oficial = on`) — último passo, só depois de
   1 e 2 estarem no ar e validados.

Cada etapa entra atrás da sua própria chave, então dá para voltar uma sem desfazer as outras.
