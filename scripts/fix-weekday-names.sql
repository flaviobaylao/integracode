-- Script para corrigir dias da semana abreviados
-- Converte: Seg → segunda, Ter → terca, etc.

-- 1. Corrigir tabela sales_cards
UPDATE sales_cards
SET route_day = CASE
  WHEN route_day = 'Seg' THEN 'segunda'
  WHEN route_day = 'Ter' THEN 'terca'
  WHEN route_day = 'Qua' THEN 'quarta'
  WHEN route_day = 'Qui' THEN 'quinta'
  WHEN route_day = 'Sex' THEN 'sexta'
  WHEN route_day = 'Sab' THEN 'sabado'
  WHEN route_day = 'Dom' THEN 'domingo'
  ELSE route_day
END
WHERE route_day IN ('Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab', 'Dom');

-- 2. Corrigir tabela visit_agenda
UPDATE visit_agenda
SET route_day = CASE
  WHEN route_day = 'Seg' THEN 'segunda'
  WHEN route_day = 'Ter' THEN 'terca'
  WHEN route_day = 'Qua' THEN 'quarta'
  WHEN route_day = 'Qui' THEN 'quinta'
  WHEN route_day = 'Sex' THEN 'sexta'
  WHEN route_day = 'Sab' THEN 'sabado'
  WHEN route_day = 'Dom' THEN 'domingo'
  ELSE route_day
END
WHERE route_day IN ('Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab', 'Dom');

-- 3. Verificar quantos registros foram corrigidos
SELECT 
  'sales_cards' as tabela,
  COUNT(*) as registros_corrigidos
FROM sales_cards
WHERE route_day IN ('segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado', 'domingo')

UNION ALL

SELECT 
  'visit_agenda' as tabela,
  COUNT(*) as registros_corrigidos
FROM visit_agenda
WHERE route_day IN ('segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado', 'domingo');
