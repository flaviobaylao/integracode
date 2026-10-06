-- =============================================================================
-- PERFORMANCE 06/10/2026 — índices que faltavam em produção
-- Rodar FORA de transação (CONCURRENTLY não roda dentro de BEGIN/COMMIT).
-- Todos idempotentes (IF NOT EXISTS). Não bloqueiam leitura nem escrita.
-- Diagnóstico: pg_stat_user_tables mostrou 183 MILHÕES de seq scans em
-- billing_pipeline (1,1 TRILHÃO de linhas lidas) — causa: o escopo por vendedor
-- do /api/dashboard2/full fazia, para CADA uma das ~60 mil NF-e, uma varredura
-- completa de billing_pipeline com regexp. A consulta levava >10 min, e cada
-- vendedor que abria o Dashboard enfileirava outra: 16 conexões presas.
-- =============================================================================

-- 1) Dashboard por vendedor: número da NF (só dígitos) em billing_pipeline.
--    A expressão PRECISA ser idêntica à de server/faturamento-oficial.ts (BP_NF_NUM).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_billing_pipeline_nf_num
  ON billing_pipeline (((CASE WHEN length(regexp_replace(COALESCE(invoice_number,''),'[^0-9]','','g')) BETWEEN 1 AND 18
                              THEN regexp_replace(COALESCE(invoice_number,''),'[^0-9]','','g')::bigint END)), created_at DESC)
  WHERE stage <> 'lixeira';

-- 2) Faturamento oficial (nfVendaFrom): ordenação da deduplicação por chave
--    (CNPJ emitente, série, número) sem sort em disco (temp_files somava 694 GB).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fiscal_invoices_dedup_venda
  ON fiscal_invoices ((COALESCE(issuer_cnpj,'')), (COALESCE(series,'')),
                      (COALESCE(invoice_number::text, 'id:' || id::text)), created_at DESC)
  WHERE status = 'authorized' AND environment = 'producao';

-- 3) Tabelas com seq scan massivo e sem índice nas colunas de filtro
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_messages_conv_created ON chat_messages (conversation_id, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_messages_unread ON chat_messages (conversation_id) WHERE sender_type = 'customer' AND is_read = false;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bsi_statement_date ON bank_statement_items (statement_id, transaction_date, id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bsi_mirror_of ON bank_statement_items (mirror_of) WHERE mirror_of IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bsi_matched_recv ON bank_statement_items (matched_receivable_id) WHERE matched_receivable_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bsi_pending_date ON bank_statement_items (transaction_date DESC) WHERE mirror_of IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_cards_seller_sched ON sales_cards (seller_id, scheduled_date);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_cards_customer_sched ON sales_cards (customer_id, scheduled_date DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_cards_customer_status ON sales_cards (customer_id, status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_customers_seller_active ON customers (seller_id) WHERE is_active = true;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_billings_invoice_date ON billings (invoice_date DESC) WHERE is_cancelled = false;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_billings_seller_invoice_date ON billings (seller_id, invoice_date DESC) WHERE is_cancelled = false;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_billings_omie_customer_date ON billings (omie_customer_code, invoice_date DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_billings_invoice_number ON billings (invoice_number);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_repescagem_assign_customer_status ON repescagem_assignments (customer_id, status);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_repescagem_assign_user_draw ON repescagem_assignments (assigned_user_id, draw_date);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vsl_customer_date ON virtual_service_logs (customer_id, attendance_date DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vsl_attendance_date ON virtual_service_logs (attendance_date);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_drs_route_order ON delivery_route_stops (route_id, stop_order);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_drs_billing ON delivery_route_stops (billing_id) WHERE billing_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_drs_sales_card ON delivery_route_stops (sales_card_id) WHERE sales_card_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_route_checkpoints_seller_time ON route_checkpoints (seller_id, checkpoint_time);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_route_checkpoints_checkin_time ON route_checkpoints (checkpoint_time) WHERE checkpoint_type = 'check_in';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_billing_pipeline_created ON billing_pipeline (created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_billing_pipeline_seller_created ON billing_pipeline (seller_id, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_billing_pipeline_invoice_number ON billing_pipeline (invoice_number) WHERE invoice_number IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_billing_pipeline_order_number ON billing_pipeline (order_number);

-- 4) FKs sem índice (DELETE/UPDATE na tabela pai varre a filha)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_orders_conversation ON chat_orders (conversation_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_orders_customer ON chat_orders (customer_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_order_history_sales_card ON order_history (sales_card_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lead_visits_lead ON lead_visits (lead_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wca_conversation ON whatsapp_conversation_analysis (conversation_id);

-- 5) Estatísticas frescas para o planejador usar os índices novos
ANALYZE billing_pipeline; ANALYZE fiscal_invoices; ANALYZE chat_messages; ANALYZE bank_statement_items;
ANALYZE sales_cards; ANALYZE customers; ANALYZE billings; ANALYZE repescagem_assignments;
ANALYZE virtual_service_logs; ANALYZE delivery_route_stops; ANALYZE route_checkpoints;
