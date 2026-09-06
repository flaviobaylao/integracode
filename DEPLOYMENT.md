# Guia de publicação (deploy) — Integra 2.0

_Atualizado em set/2026 (etapa E6). O sistema roda no **Railway**; a hospedagem antiga e o
Integra 1.0 saíram do ar._

## Como o deploy acontece

Push/merge na branch `main` do GitHub → o Railway builda (`npm run build`: vite + esbuild) e
reinicia o serviço. O banco (serviço Postgres separado) não é tocado — ver
`PERSISTENCIA_E_BACKUP.md`.

## Primeiro passo em qualquer suspeita: health check

```
https://integracode-production.up.railway.app/api/health
```

```json
{
  "status": "ok",
  "checks": { "database": true, "session": true },
  "config": {
    "baseUrl": "https://integracode-production.up.railway.app",
    "hasSessionSecret": true,
    "hasDatabaseUrl": true
  }
}
```

Qualquer check em `false` é o problema. `status: "degraded"` = falta `SESSION_SECRET`.

## Variáveis de ambiente

Railway → serviço da aplicação → aba **Variables**.

### Obrigatórias

| Variável | O que é | Observação |
|---|---|---|
| `SESSION_SECRET` | segredo do cookie de sessão | string aleatória longa; **trocar derruba todas as sessões** |
| `DATABASE_URL` | conexão com o Postgres | injetada pelo Railway ao referenciar o serviço Postgres |
| `NODE_ENV` | `production` | define cookie seguro e o modo de build servido |
| `BASE_URL` | domínio público | usado em links, upload e webhooks |

Gerar um `SESSION_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### Integrações (conforme o que estiver em uso)

`EVOLUTION_API_BASE_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE_NAME` (WhatsApp),
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (IA), credenciais do Banco do Brasil e da Cielo
(financeiro), `REDIS_URL` (filas BullMQ — opcional; sem ela as filas ficam desligadas),
`UPLOAD_DIR` (opcional: volume persistente para arquivos; sem ela, arquivos vão para o banco).

### Variáveis que NÃO devem existir mais

`OMIE_APP_KEY`, `OMIE_APP_SECRET`, `OMIE_CADASTRO_SYNC`, `SYNC_ENABLED`, `SYNC_20_ENABLED`,
`SYNC_INTERVAL_MINUTES`, `REPLIT_DATABASE_URL`, `PRIVATE_OBJECT_DIR`,
`PUBLIC_OBJECT_SEARCH_PATHS`, `DEFAULT_OBJECT_STORAGE_BUCKET_ID`. O código que as lia foi
removido nas etapas E5/E6 do desligamento do Omie. Se alguma ainda estiver no Railway, apagar.

## Checklist antes de publicar

- [ ] `npx tsc` não introduziu erro novo (a base tem erros pré-existentes conhecidos).
- [ ] `npm run build` termina com exit 0.
- [ ] Migração de dados (quando houver) rodou **antes** do deploy, com backup.
- [ ] `SESSION_SECRET` e `DATABASE_URL` presentes no Railway.

## Depois do deploy

1. `/api/health` responde `status: "ok"`.
2. Login com email + senha funciona (a autenticação é local — `server/localAuth.ts`).
3. Abrir uma tela de cada área: Rota do Dia, Pipeline de Faturamento, Contas a Receber,
   ChatCenter.
4. Logs do Railway sem `relation ... does not exist` e sem erro repetido no boot.

## Problemas comuns

**Tela em branco.** Abra o console do navegador. Quase sempre é build antigo em cache:
Ctrl+Shift+R. Se persistir, veja se o build do Railway terminou com sucesso.

**401 em tudo / cai para a tela de login.** `SESSION_SECRET` mudou ou está ausente, ou a
tabela `sessions` sumiu. Ela é criada fora do Drizzle (`createTableIfMissing: false`) —
confira que existe.

**`SESSION_SECRET must be provided` no boot.** Variável ausente; adicione e redeploy.

**Erro de conexão com o banco.** Verifique se o serviço Postgres do Railway está de pé e se
a `DATABASE_URL` referencia o serviço (e não uma URL colada à mão que expirou).

## Rollback

Railway → serviço → **Deployments** → escolha o deploy anterior → **Redeploy**. Isso volta
só o código. Se a versão nova rodou migração destrutiva, reverta a migração pelo bloco R do
arquivo SQL correspondente antes de voltar o código.
