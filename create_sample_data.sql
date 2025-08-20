-- Script para criar dados de exemplo para testar o sistema de vendas recorrentes

-- 1. Criar um cliente de exemplo
INSERT INTO customers (id, name, customer_type, cpf, phone, address, seller_id, route, weekdays, is_active) 
VALUES (
  'cliente-teste-001',
  'Maria Silva',
  'pessoa_fisica',
  '123.456.789-00',
  '(11) 99999-9999',
  'Rua das Flores, 123, Centro',
  'admin-flavio',
  'Rota Centro',
  'segunda,quarta,sexta',
  true
) 
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  phone = EXCLUDED.phone,
  address = EXCLUDED.address,
  seller_id = EXCLUDED.seller_id;

-- 2. Criar alguns produtos de exemplo
INSERT INTO products (id, name, category, price, stock_quantity, is_active)
VALUES 
  ('produto-suco-laranja', 'Suco de Laranja Natural 1L', 'Sucos Naturais', 12.50, 100, true),
  ('produto-suco-uva', 'Suco de Uva Integral 1L', 'Sucos Naturais', 15.00, 80, true),
  ('produto-suco-maracuja', 'Suco de Maracujá Natural 1L', 'Sucos Naturais', 13.50, 60, true)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  category = EXCLUDED.category,
  price = EXCLUDED.price,
  stock_quantity = EXCLUDED.stock_quantity;

-- 3. Criar um card de vendas de exemplo com recorrência
INSERT INTO sales_cards (
  id,
  customer_id,
  seller_id,
  status,
  scheduled_date,
  route_day,
  recurrence_type,
  is_recurring,
  products,
  sale_value,
  notes
) VALUES (
  'card-teste-001',
  'cliente-teste-001',
  'admin-flavio',
  'pending',
  CURRENT_DATE,
  'segunda',
  'semanal',
  true,
  '[
    {
      "id": "produto-suco-laranja",
      "name": "Suco de Laranja Natural 1L",
      "quantity": 2,
      "unitPrice": 12.50,
      "totalPrice": 25.00
    },
    {
      "id": "produto-suco-uva", 
      "name": "Suco de Uva Integral 1L",
      "quantity": 1,
      "unitPrice": 15.00,
      "totalPrice": 15.00
    }
  ]'::jsonb,
  40.00,
  'Card de exemplo para teste do sistema de vendas recorrentes'
)
ON CONFLICT (id) DO UPDATE SET
  customer_id = EXCLUDED.customer_id,
  seller_id = EXCLUDED.seller_id,
  status = EXCLUDED.status,
  scheduled_date = EXCLUDED.scheduled_date,
  route_day = EXCLUDED.route_day,
  recurrence_type = EXCLUDED.recurrence_type,
  products = EXCLUDED.products,
  sale_value = EXCLUDED.sale_value,
  notes = EXCLUDED.notes;

-- 4. Criar um agente de telemarketing de exemplo
INSERT INTO telemarketing_agents (
  id,
  user_id,
  name,
  phone,
  email,
  is_active,
  max_cards_per_day,
  current_cards_count
) VALUES (
  'agent-telemarketing-001',
  'admin-flavio', -- Usando o mesmo usuário para teste
  'Atendente de Telemarketing',
  '(11) 88888-8888',
  'telemarketing@honestsucos.com',
  true,
  50,
  0
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  phone = EXCLUDED.phone,
  email = EXCLUDED.email,
  is_active = EXCLUDED.is_active;

-- 5. Criar um card de exemplo já em atraso para testar o sistema de telemarketing
INSERT INTO sales_cards (
  id,
  customer_id,
  seller_id,
  status,
  scheduled_date,
  route_day,
  recurrence_type,
  is_recurring,
  products,
  sale_value,
  notes
) VALUES (
  'card-overdue-001',
  'cliente-teste-001',
  'admin-flavio',
  'pending',
  CURRENT_DATE - INTERVAL '1 day', -- Ontem
  'segunda',
  'semanal',
  true,
  '[
    {
      "id": "produto-suco-maracuja",
      "name": "Suco de Maracujá Natural 1L",
      "quantity": 3,
      "unitPrice": 13.50,
      "totalPrice": 40.50
    }
  ]'::jsonb,
  40.50,
  'Card em atraso para testar sistema de telemarketing'
)
ON CONFLICT (id) DO UPDATE SET
  scheduled_date = EXCLUDED.scheduled_date,
  status = EXCLUDED.status;