-- LOGÍSTICA DO PRODUTO (set/2026) — peso, dimensões, fardo e paletização.
-- O servidor roda estes ALTERs sozinho no boot (server/index.ts, bloco _critCols)
-- e preenche os produtos 350 ml / 900 ml que ainda estão sem peso. Este arquivo
-- existe só para documentação / execução manual se o boot falhar.
ALTER TABLE products ADD COLUMN IF NOT EXISTS peso_bruto_g numeric(8,1);
ALTER TABLE products ADD COLUMN IF NOT EXISTS peso_embalagem_g numeric(8,1);
ALTER TABLE products ADD COLUMN IF NOT EXISTS diametro_cm numeric(6,1);
ALTER TABLE products ADD COLUMN IF NOT EXISTS altura_cm numeric(6,1);
ALTER TABLE products ADD COLUMN IF NOT EXISTS fardo_filas integer;
ALTER TABLE products ADD COLUMN IF NOT EXISTS fardo_por_fila integer;
ALTER TABLE products ADD COLUMN IF NOT EXISTS fardo_filme_g numeric(6,1);
ALTER TABLE products ADD COLUMN IF NOT EXISTS palet_fardos_camada integer;
ALTER TABLE products ADD COLUMN IF NOT EXISTS palet_camadas integer;
ALTER TABLE products ADD COLUMN IF NOT EXISTS palet_tipo varchar;

-- Volumes da NF-e (<transp><vol>) espelhados na nota, para a DANFE.
ALTER TABLE fiscal_invoices ADD COLUMN IF NOT EXISTS vol_quantidade integer;
ALTER TABLE fiscal_invoices ADD COLUMN IF NOT EXISTS vol_especie varchar;
ALTER TABLE fiscal_invoices ADD COLUMN IF NOT EXISTS peso_liquido_kg numeric(12,3);
ALTER TABLE fiscal_invoices ADD COLUMN IF NOT EXISTS peso_bruto_kg numeric(12,3);

-- Preenchimento inicial (só onde o peso está vazio; o que for editado na tela não é tocado).
UPDATE products SET peso_bruto_g = 370, peso_embalagem_g = 17.5, diametro_cm = 6, altura_cm = 17.5,
  fardo_filas = 3, fardo_por_fila = 4, fardo_filme_g = 30, palet_fardos_camada = 25, palet_camadas = 7,
  palet_tipo = 'PBR-1 1,20 × 1,00 m'
WHERE peso_bruto_g IS NULL AND internal_only = false AND name ~* '350\s*ml';
UPDATE products SET peso_bruto_g = 930, peso_embalagem_g = 28, diametro_cm = 7, altura_cm = 24,
  fardo_filas = 2, fardo_por_fila = 3, fardo_filme_g = 30, palet_fardos_camada = 39, palet_camadas = 4,
  palet_tipo = 'PBR-1 1,20 × 1,00 m'
WHERE peso_bruto_g IS NULL AND internal_only = false AND name ~* '900\s*ml';

-- Conferência:
-- SELECT name, peso_bruto_g, fardo_filas, fardo_por_fila, palet_fardos_camada, palet_camadas FROM products WHERE is_active ORDER BY name;
