-- E2-E — Trilha obrigatória de clientes (Integra 2.0) — 06/set/2026
-- COMO RODAR: os BLOCOS 2 e 3 têm CREATE FUNCTION/TRIGGER e ALTER TABLE — o editor "Query" do
-- Railway acrescenta LIMIT e recusa. Rodar pelo psql: Railway > Postgres > Connect > copiar o
-- comando "psql ..." (ou `railway connect Postgres`) e colar o arquivo inteiro, OU rodar
-- `psql "$DATABASE_PUBLIC_URL" -f migrations/2026-09-06_e2e_trilha_clientes.sql`.
-- Os BLOCOS 1 e 4 são SELECT/CTE e também rodam no editor Query.
-- PRÉ-REQUISITO: migrations/2026-09-06_e2c_is_active_unico.sql já executada.
-- Reversível: BLOCO R no fim.

-- ============================================================================
-- BLOCO 1 — backfill: todo inativo passa a ter inactivated_at (usa updated_at
--   como melhor estimativa quando não havia). Sem isso a CHECK do BLOCO 3
--   falharia em qualquer edição de um inativo antigo.
-- ============================================================================
WITH u AS (
  UPDATE customers SET inactivated_at = COALESCE(inactivated_at, updated_at, created_at, now())
  WHERE is_active = false AND inactivated_at IS NULL
  RETURNING id
) SELECT count(*) AS inativos_com_inactivated_at_preenchido FROM u;

-- ============================================================================
-- BLOCO 2 — trigger de auditoria: qualquer mudança de is_active, seller_id,
--   cnpj, cpf, name ou fantasy_name em customers gera linha em
--   customer_change_history, mesmo por SQL direto (index.ts, migrações,
--   scripts). A trigger grava SEMPRE (source='trigger'); quando a mudança vem
--   do app, o logCustomerChanges (customerAudit.ts) ASSUME essa linha nos 20 s
--   seguintes, preenchendo ator/origem reais — sem duplicar.
-- ============================================================================
CREATE OR REPLACE FUNCTION trg_customers_audit_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_actor text := COALESCE(NULLIF(current_setting('integra.actor', true), ''), 'trigger (SQL direto)');
  v_src   text := COALESCE(NULLIF(current_setting('integra.source', true), ''), 'trigger');
BEGIN
  IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
      INSERT INTO customer_change_history (customer_id, field, label, old_value, new_value, changed_by_name, source)
      VALUES (NEW.id, 'isActive', 'Ativo', CASE WHEN OLD.is_active THEN 'Sim' ELSE 'Não' END,
              CASE WHEN NEW.is_active THEN 'Sim' ELSE 'Não' END, v_actor, v_src);
  END IF;
  IF NEW.seller_id IS DISTINCT FROM OLD.seller_id THEN
      INSERT INTO customer_change_history (customer_id, field, label, old_value, new_value, changed_by_name, source)
      VALUES (NEW.id, 'sellerId', 'Vendedor', OLD.seller_id, NEW.seller_id, v_actor, v_src);
  END IF;
  IF NEW.cnpj IS DISTINCT FROM OLD.cnpj OR NEW.cpf IS DISTINCT FROM OLD.cpf THEN
      INSERT INTO customer_change_history (customer_id, field, label, old_value, new_value, changed_by_name, source)
      VALUES (NEW.id, CASE WHEN NEW.cnpj IS DISTINCT FROM OLD.cnpj THEN 'cnpj' ELSE 'cpf' END, 'Documento',
              COALESCE(OLD.cnpj, OLD.cpf), COALESCE(NEW.cnpj, NEW.cpf), v_actor, v_src);
  END IF;
  IF NEW.name IS DISTINCT FROM OLD.name OR NEW.fantasy_name IS DISTINCT FROM OLD.fantasy_name THEN
      INSERT INTO customer_change_history (customer_id, field, label, old_value, new_value, changed_by_name, source)
      VALUES (NEW.id, CASE WHEN NEW.name IS DISTINCT FROM OLD.name THEN 'name' ELSE 'fantasyName' END, 'Nome',
              COALESCE(OLD.fantasy_name, OLD.name), COALESCE(NEW.fantasy_name, NEW.name), v_actor, v_src);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_customers_audit ON customers;
CREATE TRIGGER trg_customers_audit AFTER UPDATE ON customers
  FOR EACH ROW WHEN (OLD.is_active IS DISTINCT FROM NEW.is_active OR OLD.seller_id IS DISTINCT FROM NEW.seller_id
                     OR OLD.cnpj IS DISTINCT FROM NEW.cnpj OR OLD.cpf IS DISTINCT FROM NEW.cpf
                     OR OLD.name IS DISTINCT FROM NEW.name OR OLD.fantasy_name IS DISTINCT FROM NEW.fantasy_name)
  EXECUTE FUNCTION trg_customers_audit_fn();

SELECT tgname, tgenabled FROM pg_trigger WHERE tgname = 'trg_customers_audit';

-- ============================================================================
-- BLOCO 3 — invariante: inativo sempre com inactivated_at.
-- ============================================================================
ALTER TABLE customers DROP CONSTRAINT IF EXISTS chk_customers_inativo_com_data;
ALTER TABLE customers ADD CONSTRAINT chk_customers_inativo_com_data
  CHECK (is_active = true OR inactivated_at IS NOT NULL);
SELECT conname, convalidated FROM pg_constraint WHERE conname = 'chk_customers_inativo_com_data';

-- ============================================================================
-- BLOCO 4 — conferência
-- ============================================================================
SELECT (SELECT count(*) FROM customers WHERE is_active = false AND inactivated_at IS NULL) AS inativos_sem_data_deve_ser_0,
       (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_customers_audit') AS trigger_instalada;

-- ============================================================================
-- BLOCO R — reversão (só se precisar)
-- ============================================================================
-- DROP TRIGGER IF EXISTS trg_customers_audit ON customers;
-- DROP FUNCTION IF EXISTS trg_customers_audit_fn();
-- ALTER TABLE customers DROP CONSTRAINT IF EXISTS chk_customers_inativo_com_data;
