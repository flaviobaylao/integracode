-- Script para corrigir weekdays dos clientes importados do Omie
-- Problema: clientes do Omie foram importados com weekdays hardcoded como ["Seg","Ter","Qua","Qui","Sex"]
-- Solução: atualizar para padrão correto ["Dom"] (domingo apenas, como clientes criados manualmente)

-- Listar clientes afetados (antes da correção)
SELECT 
  id, 
  fantasy_name, 
  name,
  weekdays,
  visit_periodicity,
  seller_id
FROM customers
WHERE id LIKE 'omie-client-%'
  AND weekdays::jsonb = '["Seg","Ter","Qua","Qui","Sex"]'::jsonb
ORDER BY fantasy_name
LIMIT 20;

-- Mostrar total de clientes afetados
SELECT 
  COUNT(*) as total_clientes_afetados
FROM customers
WHERE id LIKE 'omie-client-%'
  AND weekdays::jsonb = '["Seg","Ter","Qua","Qui","Sex"]'::jsonb;

-- EXECUTAR A CORREÇÃO (descomente as linhas abaixo quando estiver pronto)
/*
UPDATE customers
SET 
  weekdays = '["Dom"]'::jsonb,
  visit_periodicity = 'semanal'
WHERE id LIKE 'omie-client-%'
  AND weekdays::jsonb = '["Seg","Ter","Qua","Qui","Sex"]'::jsonb;

-- Verificar resultado
SELECT 
  COUNT(*) as total_corrigidos,
  weekdays,
  visit_periodicity
FROM customers
WHERE id LIKE 'omie-client-%'
GROUP BY weekdays, visit_periodicity
ORDER BY weekdays;
*/
