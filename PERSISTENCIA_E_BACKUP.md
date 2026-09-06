# Persistência e backup de dados — Integra 2.0

_Atualizado em set/2026 (etapa E6 do desligamento do Omie/Integra 1.0). Substitui a versão
anterior, escrita quando o sistema rodava hospedado fora e o banco era o Neon._

## Onde os dados moram

Tudo fica em um **PostgreSQL gerenciado pelo Railway**, no mesmo projeto do serviço da
aplicação, mas em **serviço separado** — o deploy do código não toca no banco.

| Item | Onde |
|---|---|
| Aplicação (Node + React buildado) | Railway → serviço `integracode` |
| Banco | Railway → serviço **Postgres** |
| Conexão da aplicação | variável `DATABASE_URL` (injetada pelo Railway) |
| Conexão externa (psql, pg_dump) | variável `DATABASE_PUBLIC_URL` |
| Domínio de produção | `BASE_URL` / `integracode-production.up.railway.app` |

Arquivos enviados pelos usuários (mídia do WhatsApp, fotos de entrega, certificados A1)
**também ficam no banco**, não em disco: `chat_media`, `photo_media`, `stored_objects`,
`digital_certificates.pfx_data` (cifrado). O disco do container é efêmero — some a cada
deploy. Só se `UPLOAD_DIR` apontar para um volume persistente o sistema grava em disco.

> Não existe mais object storage externo. URLs antigas no formato `/api/storage-image/...`
> respondem **410** (mídia daquela época não é mais recuperável pelo sistema).

## O que acontece num deploy

1. Railway builda o código (`vite` + `esbuild`) e reinicia o serviço da aplicação.
2. O banco **não é tocado**: nada de recriar tabela, nada de apagar dado.
3. No boot, o servidor roda `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` idempotentes para as
   colunas novas. Nenhum `DROP`.

Mudança de schema que apaga coisa (DROP de tabela/coluna) **nunca** vai junto do deploy:
sai em migração SQL separada, com cópia `*_bkp_<data>` antes e bloco de reversão — o padrão
usado nas etapas E2-C, E2-E e E5.6 do desligamento.

## Backups

### Automático (Railway)

O serviço Postgres do Railway tem **backups gerenciados + PITR (point-in-time recovery)**.
Ver e restaurar: Railway → serviço **Postgres** → aba **Backups**.

### Manual, antes de qualquer migração de risco

```powershell
# 1) pegar a URL pública: Railway -> Postgres -> Connect -> "Postgres Connection URL"
pg_dump "<DATABASE_PUBLIC_URL>" -Fc -f integra_20260906.dump

# conferir o tamanho (o dump completo tem alguns GB)
dir integra_20260906.dump
```

Guardar no OneDrive, na pasta de backups do Integra. O último backup completo antes da
Fase 2 tinha 3,61 GB.

Restaurar (em um banco vazio, **nunca** por cima do de produção sem necessidade):

```powershell
pg_restore -d "<URL_DO_BANCO_DESTINO>" --clean --if-exists integra_20260906.dump
```

### Cópias pontuais de tabela (o padrão das migrações)

Antes de dropar qualquer coisa:

```sql
CREATE TABLE IF NOT EXISTS <tabela>_bkp_20260906 AS SELECT * FROM <tabela>;
-- conferir a contagem origem x cópia ANTES do DROP
```

Cópias vivas hoje: `omie_instances_credenciais_bkp_20260905` (E0) e as criadas pela
migração E5.6 (`omie_stage_logs`, `omie_sync_attempts`, `sync_status`, `overdue_debts`,
`active_customer_uploads`).

## Como rodar SQL em produção

- **Editor Query do Railway** (Postgres → Query): bom para `SELECT` e `UPDATE` simples.
  Ele acrescenta `LIMIT` sozinho e **recusa DDL** (`CREATE FUNCTION`, `ALTER TABLE`,
  `DROP`) — migração com DDL não vai por aqui.
- **psql** (Railway → Postgres → Connect → copiar o comando `psql "postgresql://..."`):
  obrigatório para migração com DDL.

```powershell
psql "<DATABASE_PUBLIC_URL>" -f migrations\2026-09-XX_e5_drop_tabelas_omie.sql
```

## Trilha de alteração de cadastro

`customers` tem a trigger `trg_customers_audit`: qualquer mudança de ativo, vendedor,
documento ou nome — **inclusive por SQL direto** — vira linha em `customer_change_history`.
Não existe alteração de cadastro sem rastro; o CHECK `chk_customers_inativo_com_data` garante
que todo inativo tem `inactivated_at`.

## O que fazer se algo sumir

1. **Não** rode mais nada de escrita. Anote a hora aproximada do problema.
2. Railway → Postgres → Backups → **PITR** para o instante anterior (restaura num banco novo,
   não por cima).
3. Compare a tabela suspeita entre o banco restaurado e o de produção antes de copiar de volta.
4. `customer_change_history` diz quem mudou o quê e quando — comece por ela.

## Checklist mensal (5 min)

- [ ] Railway → Postgres → Backups: o mais recente é de hoje?
- [ ] `pg_dump` manual do mês guardado no OneDrive.
- [ ] Tamanho do banco não explodiu (mídia em `chat_media`/`stored_objects` é o que mais cresce).
- [ ] Nenhuma tabela `*_bkp_*` esquecida além das que a documentação lista.
