-- ============================================================================
-- E2-C (06/set/2026) — "uma única regra de ativo"
-- customers.is_active passa a ser a ÚNICA verdade; omie_status deixa de ter função
-- (a coluna fica no banco até a E7, sem leitura nem escrita pelo código).
--
-- Regra antiga (dupla): ativo = is_active=true AND omie_status='ativo'.
-- Esta migração consolida: quem estava is_active=true mas omie_status<>'ativo'
-- (cadastros "excluídos" que a regra dupla já escondia) vira is_active=false.
-- Depois disso, ler só is_active dá o MESMO resultado da regra dupla.
--
-- Rodar os blocos NA ORDEM, um de cada vez, no editor SQL do Railway.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- BLOCO 1 — LEITURA (conferência ANTES): quem vai mudar (esperado: 16 linhas)
-- ----------------------------------------------------------------------------
SELECT
  c.id,
  COALESCE(NULLIF(c.fantasy_name, ''), c.name) AS nome,
  COALESCE(NULLIF(c.cnpj, ''), c.cpf)           AS documento,
  c.omie_status,
  c.is_active,
  c.seller_id,
  c.city,
  COUNT(*) OVER ()                              AS total_a_mudar
FROM customers c
WHERE c.is_active
  AND COALESCE(c.omie_status, '') <> 'ativo'
ORDER BY nome;


-- ----------------------------------------------------------------------------
-- BLOCO 2 — ESCRITA (como SELECT com CTEs: o editor do Railway acrescenta LIMIT
-- e recusa UPDATE puro). Idempotente: na segunda execução devolve 0.
--   1) UPDATE customers: is_active=false, inactivated_at (se vazio), updated_at
--   2) histórico field='isActive'  (Ativo: Sim -> Não)
--   3) histórico field='motivo'    (Motivo da inativação)
-- ----------------------------------------------------------------------------
WITH alvo AS (
  UPDATE customers
     SET is_active      = false,
         inactivated_at = COALESCE(inactivated_at, now()),
         updated_at     = now()
   WHERE is_active
     AND COALESCE(omie_status, '') <> 'ativo'
  RETURNING id
),
hist_ativo AS (
  INSERT INTO customer_change_history
    (customer_id, field, label, old_value, new_value, changed_by_user_id, changed_by_name, source)
  SELECT id, 'isActive', 'Ativo', 'Sim', 'Não', NULL, 'Migração E2-C', 'migracao-e2c'
    FROM alvo
  RETURNING customer_id
),
hist_motivo AS (
  INSERT INTO customer_change_history
    (customer_id, field, label, old_value, new_value, changed_by_user_id, changed_by_name, source)
  SELECT id, 'motivo', 'Motivo da inativação', NULL,
         'Consolidação is_active único: cadastro estava marcado excluído (omie_status<>ativo) em 06/set/2026',
         NULL, 'Migração E2-C', 'migracao-e2c'
    FROM alvo
  RETURNING customer_id
)
SELECT
  (SELECT count(*) FROM alvo)        AS clientes_inativados,
  (SELECT count(*) FROM hist_ativo)  AS historico_ativo,
  (SELECT count(*) FROM hist_motivo) AS historico_motivo;


-- ----------------------------------------------------------------------------
-- BLOCO 3 — LEITURA (conferência DEPOIS): deve devolver 0
-- ----------------------------------------------------------------------------
SELECT count(*) AS divergentes_restantes
FROM customers
WHERE is_active
  AND COALESCE(omie_status, '') <> 'ativo';

-- Opcional: ver o que a migração gravou no histórico
-- SELECT customer_id, field, label, old_value, new_value, changed_by_name, source, created_at
--   FROM customer_change_history WHERE source = 'migracao-e2c' ORDER BY created_at DESC;
