// server/comodatos-routes.ts
// -----------------------------------------------------------------------------
// CONTRATOS DE COMODATO (tela /comodatos, grupo Clientes) — 04/out/2026
//
// Cadastro dos contratos de comodato de freezer/geladeira que a PURO INDUSTRIA
// (comodante, CNPJ 28.295.493/0001-53) assina com os pontos de venda que
// revendem Honest. Cada contrato guarda:
//   - comodatário (razão social, CNPJ, apelido do ponto, endereço de instalação)
//     + vínculo opcional com o cliente cadastrado (customers.id, casado por CNPJ)
//   - equipamento (tipo, marca, modelo, nº de série, código do produto, tensão,
//     volume, volume bruto) e valor do bem (cláusula 7ª)
//   - data do contrato, prazo (indeterminado — cláusula 2ª), status
//   - assinaturas (comodante / comodatário / 2 testemunhas) e signatário
//   - devolução (data + condição) e observações
//   - anexos (fotos/PDF do contrato assinado; base64 em tabela própria, até 15MB)
//
// A lista devolve `pendencias` calculadas (sem data, sem assinatura da Puro,
// sem nº de série, sem testemunhas, sem vínculo com cliente…) para a tela
// mostrar o que falta regularizar.
//
// Carga inicial: os 11 contratos físicos fotografados em 04/out/2026 entram
// sozinhos no boot (seed idempotente por seed_ref). Depois disso o cadastro é
// do usuário — editar/excluir pela tela não é desfeito no próximo boot.
//
// Acesso: admin / coordinator / administrative.
// -----------------------------------------------------------------------------
import type { Express, Request, Response } from "express";
import multer from "multer";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser, requireRole } from "./authMiddleware";
import { receitaService } from "./receitaIntegration";
import { montarContratoComodatoPdf, montarDistratoComodatoPdf, dadosDoContrato, SIGNATARIO_COMODANTE_PADRAO } from "./comodato-pdf";

const ROLES = ["admin", "coordinator", "administrative"];
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const STATUS_VALIDOS = ["ativo", "pendente_assinatura", "encerrado", "devolvido", "cancelado"];
const TIPOS_EQUIP = ["freezer", "geladeira", "visa_cooler", "outro"];

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES } });

const COMODANTE_PADRAO = {
  razao: "PURO INDUSTRIA E COMERCIO DE PRODUTOS NATURAIS LTDA",
  cnpj: "28.295.493/0001-53",
};

// ---------------------------------------------------------------------------
// Carga inicial — transcrição dos contratos físicos (fotos de 04/out/2026).
// Campos em branco no papel ficam null; o que não deu para ler vai em observações.
// Nomes de signatários NÃO ficam aqui (repositório público): entram pela tela.
// ---------------------------------------------------------------------------
const SEED: any[] = [
  {
    seed_ref: "foto-2026-10-04-santa-rosa",
    apelido: "Externato (3 unidades)",
    razao: "COLEGIO SANTA ROSA DE LIMA", cnpj: "33.707.746/0012-41",
    endereco: "Rua 18, 221, Setor Oeste", cidade: "Goiânia", uf: "GO", cep: "74.120-080",
    tipo: "freezer", marca: "Gelopar", modelo: "80677042", serie: "2025034348", codigo: null,
    tensao: null, volume: null, volume_bruto: null,
    valor: 4000.0, data: "2025-03-19", status: "ativo",
    ass_comodante: true, ass_comodatario: true, testemunhas: false,
    obs: "Anotação manuscrita no topo: \"Externato 3 unidades\". Marca \"X\" à margem da cláusula 5ª. Testemunhas em branco.",
  },
  {
    seed_ref: "foto-2026-10-04-grilo",
    apelido: "Colégio Marista",
    razao: "GRILO LANCHES LTDA", cnpj: "12.552.365/0002-99",
    endereco: "Av. 85, nº 1440, Qd D12A, Lt 13, Marista", cidade: "Goiânia", uf: "GO", cep: "74.160-010",
    tipo: "geladeira", marca: "Gelopar", modelo: "80677042", serie: "2025034350", codigo: null,
    tensao: "220V", volume: null, volume_bruto: null,
    valor: 4000.0, data: "2025-03-27", status: "pendente_assinatura",
    ass_comodante: false, ass_comodatario: true, testemunhas: false,
    obs: "Anotação manuscrita no topo: \"Colégio Marista\". Falta a assinatura da PURO (comodante). Testemunhas em branco.",
  },
  {
    seed_ref: "foto-2026-10-04-gusto",
    apelido: "Inter America",
    razao: "GUSTO LANCHONETES ESCOLARES", cnpj: "42.929.119/0001-93",
    endereco: "Rua C 242, 42", cidade: "Goiânia", uf: "GO", cep: "74.290-170",
    tipo: "geladeira", marca: "Gelopar", modelo: "80677042", serie: "2025034355", codigo: "80677042",
    tensao: "220V", volume: null, volume_bruto: null,
    valor: 4000.0, data: "2025-03-28", status: "pendente_assinatura",
    ass_comodante: false, ass_comodatario: true, testemunhas: false,
    obs: "Anotação manuscrita no topo: \"Inter America\". Falta a assinatura da PURO (comodante). Testemunhas em branco.",
  },
  {
    seed_ref: "foto-2026-10-04-tidbit",
    apelido: null,
    razao: "TIDBIT LANCHONETE ESCOLARES LTDA", cnpj: "02.978.166/0001-02",
    endereco: "Pç. Comendador Germando Roriz, 275", cidade: "Goiânia", uf: "GO", cep: "74.093-320",
    tipo: "geladeira", marca: "Gelopar", modelo: "80677042", serie: "2025034347", codigo: "80677042",
    tensao: "220V", volume: null, volume_bruto: null,
    valor: 4000.0, data: "2025-03-28", status: "ativo",
    ass_comodante: true, ass_comodatario: true, testemunhas: false,
    obs: "Rubrica na 1ª página. Testemunhas em branco.",
  },
  {
    seed_ref: "foto-2026-10-04-cl-dias",
    apelido: "Copa (leitura incerta)",
    razao: "CL DIAS GESTAO E CONSULTORIA LTDA", cnpj: "40.670.752/0001-84",
    endereco: "Rua 34, 42, Marista", cidade: "Goiânia", uf: "GO", cep: "74.150-220",
    tipo: "geladeira", marca: "Gelopar", modelo: "80677042", serie: "2025034346", codigo: "80677042",
    tensao: "220V", volume: null, volume_bruto: null,
    valor: 4000.0, data: "2025-04-15", status: "ativo",
    ass_comodante: true, ass_comodatario: true, testemunhas: false,
    obs: "Anotação manuscrita no topo de leitura incerta (\"Copa\"?). Rubrica na 1ª página. Testemunhas em branco.",
  },
  {
    seed_ref: "foto-2026-10-04-cafe-restaurante",
    apelido: "Jdois (leitura incerta)",
    razao: "CAFE RESTAURANTE COMERCIO E SERVICO LTDA", cnpj: "14.117.474/0001-22",
    endereco: "Rua 134, 155, Qd 10, Lt 01 A, Loja 78", cidade: "Goiânia", uf: "GO", cep: "74.120-170",
    tipo: "freezer", marca: "Fricon", modelo: null, serie: null, codigo: null,
    tensao: null, volume: null, volume_bruto: null,
    valor: 4500.0, data: "2025-04-24", status: "ativo",
    ass_comodante: true, ass_comodatario: true, testemunhas: false,
    obs: "Anotação manuscrita no topo de leitura incerta. No papel só a marca (Fricon) foi preenchida — modelo, série, código, tensão e volumes em branco. Testemunhas em branco.",
  },
  {
    seed_ref: "foto-2026-10-04-casa-oeste",
    apelido: "Pão e Cia",
    razao: "CASA OESTE DE PAES LTDA", cnpj: "00.087.626/0001-87",
    endereco: "Av. República do Líbano, nº 2.376, Qd E-07, Lt 71", cidade: "Goiânia", uf: "GO", cep: "74.115-030",
    tipo: "freezer", marca: "Metalfrio", modelo: "VB28R", serie: null, codigo: null,
    tensao: "220V", volume: 296, volume_bruto: 296,
    valor: 3550.33, data: null, status: "ativo",
    ass_comodante: true, ass_comodatario: true, testemunhas: false,
    obs: "Anotação manuscrita no topo: \"Pão e Cia\". Data do contrato em branco no papel. Testemunhas em branco.",
  },
  {
    seed_ref: "foto-2026-10-04-della",
    apelido: "Della",
    razao: "DELLA PANIFICADORA E LANCHONETE LTDA", cnpj: "01.789.345/0001-39",
    endereco: "Pç. Wilson Sales, Quadra 576, Lote 6/7/8/9/10, Nova Suíça", cidade: "Goiânia", uf: "GO", cep: "74.280-370",
    tipo: "freezer", marca: "Fricon", modelo: null, serie: null, codigo: null,
    tensao: null, volume: null, volume_bruto: null,
    valor: 3550.33, data: null, status: "ativo",
    ass_comodante: true, ass_comodatario: true, testemunhas: false,
    obs: "Anotação manuscrita no topo: \"Della\". Data do contrato em branco. No papel só a marca (Fricon) foi preenchida. Testemunhas em branco.",
  },
  {
    seed_ref: "foto-2026-10-04-emporio-dolcci",
    apelido: "Dolcci (leitura incerta)",
    razao: "EMPORIO DOLCCI COMERCIAL DE ALIMENTOS LTDA", cnpj: "08.898.559/0001-92",
    endereco: "Av. C-4, nº 40, Qd 489, Lt 5, 6, 7 e 8, Jardim América", cidade: "Goiânia", uf: "GO", cep: null,
    tipo: "geladeira", marca: "Metalfrio", modelo: "VB28RH", serie: null, codigo: null,
    tensao: null, volume: null, volume_bruto: null,
    valor: 2000.0, data: "2020-07-09", status: "ativo",
    ass_comodante: true, ass_comodatario: true, testemunhas: false,
    obs: "Modelo antigo de contrato (2020). Geladeira entregue USADA. Cláusula 1ª traz o texto-modelo \"rua TAL, nº 000000\" antes do endereço. Sem multa por produto de terceiros (cláusula 4ª). Rubricas na 1ª página. Testemunhas em branco.",
  },
  {
    seed_ref: "foto-2026-10-04-moreira",
    apelido: "Moreira Av. E",
    razao: "SUPERMERCADO MOREIRA LTDA", cnpj: "00.148.007/0009-02",
    endereco: "Av. E, s/n, Qd B5, Lt 01E", cidade: "Goiânia", uf: "GO", cep: "74.810-030",
    tipo: "freezer", marca: "Metalfrio", modelo: "VB28RB", serie: null, codigo: null,
    tensao: "220V", volume: 296, volume_bruto: 296,
    valor: 3550.33, data: "2024-11-01", status: "ativo",
    ass_comodante: true, ass_comodatario: true, testemunhas: false,
    nf_numero: "219.082", nf_data: "2024-10-16", nf_fornecedor: "SALVADOR COMERCIAL DE MAQ E EQUIP DE REFRIG LTDA (CNPJ 03.249.735/0001-41)", nf_valor: 3550.33,
    obs: "Contrato impresso com \"SUPERMECADO\" e tensão \"200V\"; a NF de compra diz 220V. Aquisição: NF-e 219.082 de 16/10/2024 (refrigerador porta de vidro 296 L VB28RB Metalfrio 220V), emitida em nome de pessoa física e não da PURO. Testemunhas em branco.",
  },
  {
    seed_ref: "foto-2026-10-04-dallago",
    apelido: "Rio Verde",
    razao: "DALLAGO DISTRIBUICAO LTDA", cnpj: "46.706.596/0001-40",
    endereco: "Rua Honório (nome completo ilegível na foto), s/n, Qd 81, Lt 12", cidade: "Rio Verde", uf: "GO", cep: "75.909-070",
    tipo: "freezer", marca: "Metalfrio", modelo: "VN44R", serie: null, codigo: "VN44RLDE15",
    tensao: "220V", volume: 387, volume_bruto: null,
    valor: 4500.0, data: null, status: "ativo",
    ass_comodante: true, ass_comodatario: true, testemunhas: false,
    obs: "Foto desfocada: nº de série e o dia da data ilegíveis — contrato de agosto/2024. Impresso com tensão \"200V\". Rubricas na 1ª página. Testemunhas em branco.",
  },
];

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------
let schemaReady: Promise<void> | null = null;
export function ensureComodatosSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.execute(sql.raw(
        "CREATE TABLE IF NOT EXISTS comodato_contracts (" +
        "id varchar PRIMARY KEY DEFAULT gen_random_uuid()::varchar, " +
        "numero serial, " +
        "seed_ref varchar UNIQUE, " +
        "customer_id varchar, " +
        "comodante_razao text NOT NULL DEFAULT '" + COMODANTE_PADRAO.razao + "', " +
        "comodante_cnpj varchar NOT NULL DEFAULT '" + COMODANTE_PADRAO.cnpj + "', " +
        "comodatario_razao text NOT NULL, " +
        "comodatario_cnpj varchar, " +
        "apelido_ponto text, " +
        "endereco_instalacao text, " +
        "cidade varchar, " +
        "uf varchar(2), " +
        "cep varchar(12), " +
        "equipamento_tipo varchar NOT NULL DEFAULT 'freezer', " +
        "marca varchar, " +
        "modelo varchar, " +
        "numero_serie varchar, " +
        "codigo_produto varchar, " +
        "tensao varchar, " +
        "volume_litros numeric(10,2), " +
        "volume_bruto_litros numeric(10,2), " +
        "valor_bem numeric(12,2), " +
        "data_contrato date, " +
        "prazo text NOT NULL DEFAULT 'Indeterminado', " +
        "status varchar NOT NULL DEFAULT 'ativo', " +
        "assinado_comodante boolean NOT NULL DEFAULT false, " +
        "assinado_comodatario boolean NOT NULL DEFAULT false, " +
        "testemunhas_assinadas boolean NOT NULL DEFAULT false, " +
        "signatario_comodatario text, " +
        "data_devolucao date, " +
        "condicao_devolucao text, " +
        "observacoes text, " +
        "nf_aquisicao_numero varchar, nf_aquisicao_data date, nf_aquisicao_fornecedor text, nf_aquisicao_valor numeric(12,2), " +
        "created_by varchar, updated_by varchar, " +
        "created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), " +
        "deleted_at timestamptz)"
      ));
      for (const c of ["nf_aquisicao_numero varchar", "nf_aquisicao_data date", "nf_aquisicao_fornecedor text", "nf_aquisicao_valor numeric(12,2)",
                       "signatario_comodante text", "equipamento_usado boolean NOT NULL DEFAULT false",
                       "distrato_data date", "distrato_motivo text", "distrato_pendencias text"]) {
        await db.execute(sql.raw("ALTER TABLE comodato_contracts ADD COLUMN IF NOT EXISTS " + c)).catch(() => {});
      }
      await db.execute(sql.raw(
        "CREATE INDEX IF NOT EXISTS idx_comodato_cnpj ON comodato_contracts (regexp_replace(coalesce(comodatario_cnpj,''),'[^0-9]','','g'))"
      )).catch(() => {});
      await db.execute(sql.raw(
        "CREATE INDEX IF NOT EXISTS idx_comodato_customer ON comodato_contracts (customer_id)"
      )).catch(() => {});
      await db.execute(sql.raw(
        "CREATE TABLE IF NOT EXISTS comodato_attachments (" +
        "id varchar PRIMARY KEY DEFAULT gen_random_uuid()::varchar, " +
        "contract_id varchar NOT NULL, " +
        "file_name text, mimetype text, file_size integer NOT NULL DEFAULT 0, " +
        "data text, descricao text, " +
        "created_by varchar, created_at timestamptz DEFAULT now())"
      ));
      await db.execute(sql.raw(
        "CREATE INDEX IF NOT EXISTS idx_comodato_att_contract ON comodato_attachments (contract_id)"
      )).catch(() => {});

      // carga inicial (idempotente por seed_ref; excluído pela tela não volta,
      // porque a exclusão é lógica — deleted_at — e a linha continua existindo)
      for (const s of SEED) {
        await db.execute(sql`
          INSERT INTO comodato_contracts (
            seed_ref, comodatario_razao, comodatario_cnpj, apelido_ponto, endereco_instalacao,
            cidade, uf, cep, equipamento_tipo, marca, modelo, numero_serie, codigo_produto,
            tensao, volume_litros, volume_bruto_litros, valor_bem, data_contrato, status,
            assinado_comodante, assinado_comodatario, testemunhas_assinadas,
            nf_aquisicao_numero, nf_aquisicao_data, nf_aquisicao_fornecedor, nf_aquisicao_valor,
            observacoes, created_by)
          VALUES (
            ${s.seed_ref}, ${s.razao}, ${s.cnpj}, ${s.apelido}, ${s.endereco},
            ${s.cidade}, ${s.uf}, ${s.cep}, ${s.tipo}, ${s.marca}, ${s.modelo}, ${s.serie}, ${s.codigo},
            ${s.tensao}, ${s.volume}, ${s.volume_bruto}, ${s.valor}, ${s.data}, ${s.status},
            ${s.ass_comodante}, ${s.ass_comodatario}, ${s.testemunhas},
            ${s.nf_numero ?? null}, ${s.nf_data ?? null}, ${s.nf_fornecedor ?? null}, ${s.nf_valor ?? null},
            ${s.obs}, 'carga-inicial')
          ON CONFLICT (seed_ref) DO NOTHING`).catch((e: any) => console.error("[comodatos] seed", s.seed_ref, e?.message));
      }
      await vincularClientesPorCnpj();
    })().catch((e: any) => {
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

/** Casa contratos sem cliente com customers pelo CNPJ (só dígitos). */
async function vincularClientesPorCnpj(id?: string) {
  await db.execute(sql`
    UPDATE comodato_contracts c
       SET customer_id = cu.id
      FROM customers cu
     WHERE c.customer_id IS NULL
       AND c.comodatario_cnpj IS NOT NULL
       AND length(regexp_replace(c.comodatario_cnpj, '[^0-9]', '', 'g')) >= 11
       AND regexp_replace(coalesce(cu.cnpj, cu.cpf, ''), '[^0-9]', '', 'g') = regexp_replace(c.comodatario_cnpj, '[^0-9]', '', 'g')
       ${id ? sql`AND c.id = ${id}` : sql``}`).catch((e: any) => console.error("[comodatos] vínculo", e?.message));
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
type Pend = { codigo: string; texto: string; gravidade: "alta" | "media" | "baixa" };

function pendencias(r: any): Pend[] {
  const p: Pend[] = [];
  const ativo = !["encerrado", "devolvido", "cancelado"].includes(r.status);
  if (!ativo) return p;
  if (!r.assinado_comodante) p.push({ codigo: "sem_ass_puro", texto: "Falta assinatura da PURO", gravidade: "alta" });
  if (!r.assinado_comodatario) p.push({ codigo: "sem_ass_cliente", texto: "Falta assinatura do comodatário", gravidade: "alta" });
  if (!r.data_contrato) p.push({ codigo: "sem_data", texto: "Contrato sem data", gravidade: "media" });
  if (!r.numero_serie) p.push({ codigo: "sem_serie", texto: "Equipamento sem nº de série", gravidade: "media" });
  if (!r.endereco_instalacao) p.push({ codigo: "sem_endereco", texto: "Sem endereço de instalação", gravidade: "media" });
  if (r.valor_bem == null) p.push({ codigo: "sem_valor", texto: "Sem valor do bem", gravidade: "media" });
  if (!r.customer_id) p.push({ codigo: "sem_cliente", texto: "Não vinculado a cliente cadastrado", gravidade: "baixa" });
  if (!r.testemunhas_assinadas) p.push({ codigo: "sem_testemunhas", texto: "Sem testemunhas", gravidade: "baixa" });
  if (Number(r.anexos || 0) === 0) p.push({ codigo: "sem_anexo", texto: "Sem cópia digitalizada anexada", gravidade: "baixa" });
  return p;
}

const txt = (v: any) => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};
const numOrNull = (v: any) => {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const raw = String(v).trim();
  const norm = raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
  const n = Number(norm.replace(/[^\d.-]/g, ""));
  return isNaN(n) ? null : n;
};
const numPlain = (v: any) => {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  return isNaN(n) ? null : n;
};
const dateOrNull = (v: any) => {
  if (v === undefined) return undefined;
  const s = txt(v);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};
const boolOr = (v: any) => (v === undefined ? undefined : v === true || v === "true" || v === 1 || v === "1");

/** Campos editáveis → coluna. */
const CAMPOS: Record<string, { col: string; conv: (v: any) => any }> = {
  customerId: { col: "customer_id", conv: txt },
  comodanteRazao: { col: "comodante_razao", conv: txt },
  comodanteCnpj: { col: "comodante_cnpj", conv: txt },
  comodatarioRazao: { col: "comodatario_razao", conv: txt },
  comodatarioCnpj: { col: "comodatario_cnpj", conv: txt },
  apelidoPonto: { col: "apelido_ponto", conv: txt },
  enderecoInstalacao: { col: "endereco_instalacao", conv: txt },
  cidade: { col: "cidade", conv: txt },
  uf: { col: "uf", conv: (v) => { const s = txt(v); return s ? s.toUpperCase().slice(0, 2) : s; } },
  cep: { col: "cep", conv: txt },
  equipamentoTipo: { col: "equipamento_tipo", conv: (v) => { const s = txt(v); return s && TIPOS_EQUIP.includes(s) ? s : (s === undefined ? undefined : "outro"); } },
  marca: { col: "marca", conv: txt },
  modelo: { col: "modelo", conv: txt },
  numeroSerie: { col: "numero_serie", conv: txt },
  codigoProduto: { col: "codigo_produto", conv: txt },
  tensao: { col: "tensao", conv: txt },
  volumeLitros: { col: "volume_litros", conv: numPlain },
  volumeBrutoLitros: { col: "volume_bruto_litros", conv: numPlain },
  valorBem: { col: "valor_bem", conv: (v) => (typeof v === "number" ? v : numOrNull(v)) },
  dataContrato: { col: "data_contrato", conv: dateOrNull },
  prazo: { col: "prazo", conv: txt },
  status: { col: "status", conv: (v) => { const s = txt(v); return s && STATUS_VALIDOS.includes(s) ? s : undefined; } },
  assinadoComodante: { col: "assinado_comodante", conv: boolOr },
  assinadoComodatario: { col: "assinado_comodatario", conv: boolOr },
  testemunhasAssinadas: { col: "testemunhas_assinadas", conv: boolOr },
  signatarioComodatario: { col: "signatario_comodatario", conv: txt },
  signatarioComodante: { col: "signatario_comodante", conv: txt },
  equipamentoUsado: { col: "equipamento_usado", conv: boolOr },
  distratoData: { col: "distrato_data", conv: dateOrNull },
  distratoMotivo: { col: "distrato_motivo", conv: txt },
  distratoPendencias: { col: "distrato_pendencias", conv: txt },
  dataDevolucao: { col: "data_devolucao", conv: dateOrNull },
  condicaoDevolucao: { col: "condicao_devolucao", conv: txt },
  observacoes: { col: "observacoes", conv: txt },
  nfAquisicaoNumero: { col: "nf_aquisicao_numero", conv: txt },
  nfAquisicaoData: { col: "nf_aquisicao_data", conv: dateOrNull },
  nfAquisicaoFornecedor: { col: "nf_aquisicao_fornecedor", conv: txt },
  nfAquisicaoValor: { col: "nf_aquisicao_valor", conv: (v) => (typeof v === "number" ? v : numOrNull(v)) },
};

function montarCampos(body: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, def] of Object.entries(CAMPOS)) {
    if (!(k in (body || {}))) continue;
    const v = def.conv(body[k]);
    if (v !== undefined) out[def.col] = v;
  }
  return out;
}

const userId = (req: Request) => (req as any).currentUser?.id || null;

async function carregar(id?: string) {
  const r: any = await db.execute(sql`
    SELECT c.*,
           to_char(c.data_contrato, 'YYYY-MM-DD') AS data_contrato,
           to_char(c.data_devolucao, 'YYYY-MM-DD') AS data_devolucao,
           to_char(c.nf_aquisicao_data, 'YYYY-MM-DD') AS nf_aquisicao_data,
           to_char(c.distrato_data, 'YYYY-MM-DD') AS distrato_data,
           cu.name AS cliente_nome, cu.fantasy_name AS cliente_fantasia,
           cu.company_name AS cliente_razao, coalesce(cu.cnpj, cu.cpf) AS cliente_cnpj,
           cu.seller_id AS vendedor_id,
           NULLIF(TRIM(coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'')), '') AS vendedor_nome,
           (SELECT COUNT(*)::int FROM comodato_attachments a WHERE a.contract_id = c.id) AS anexos,
           (SELECT coalesce(json_agg(json_build_object('id', a.id, 'file_name', a.file_name, 'mimetype', a.mimetype) ORDER BY a.created_at), '[]'::json)
              FROM comodato_attachments a WHERE a.contract_id = c.id) AS anexos_lista
      FROM comodato_contracts c
      LEFT JOIN customers cu ON cu.id = c.customer_id
      LEFT JOIN users u ON u.id = cu.seller_id
     WHERE c.deleted_at IS NULL
       ${id ? sql`AND c.id = ${id}` : sql``}
     ORDER BY c.numero ASC`);
  return (r.rows || []).map((row: any) => ({
    ...row,
    valor_bem: row.valor_bem == null ? null : Number(row.valor_bem),
    volume_litros: row.volume_litros == null ? null : Number(row.volume_litros),
    volume_bruto_litros: row.volume_bruto_litros == null ? null : Number(row.volume_bruto_litros),
    nf_aquisicao_valor: row.nf_aquisicao_valor == null ? null : Number(row.nf_aquisicao_valor),
    codigo: "COM-" + String(row.numero).padStart(4, "0"),
    pendencias: pendencias(row),
  }));
}

// ---------------------------------------------------------------------------
// rotas
// ---------------------------------------------------------------------------
export function registerComodatosRoutes(app: Express) {
  const guard = [authenticateUser, requireRole(ROLES)];
  ensureComodatosSchema().catch((e) => console.error("[comodatos] schema", e?.message));

  // lista + resumo
  app.get("/api/comodatos", ...guard, async (_req: Request, res: Response) => {
    try {
      await ensureComodatosSchema();
      const itens = await carregar();
      const ativos = itens.filter((i: any) => !["encerrado", "devolvido", "cancelado"].includes(i.status));
      const resumo = {
        total: itens.length,
        ativos: ativos.length,
        equipamentosEmCampo: ativos.length,
        valorEmCampo: Math.round(ativos.reduce((s: number, i: any) => s + (Number(i.valor_bem) || 0), 0) * 100) / 100,
        comPendencia: ativos.filter((i: any) => i.pendencias.some((p: Pend) => p.gravidade !== "baixa")).length,
        semAssinaturaPuro: ativos.filter((i: any) => !i.assinado_comodante).length,
        porMarca: Object.entries(
          ativos.reduce((m: Record<string, number>, i: any) => {
            const k = i.marca || "Não informada"; m[k] = (m[k] || 0) + 1; return m;
          }, {}),
        ).map(([marca, qtd]) => ({ marca, qtd })),
      };
      res.json({ itens, resumo });
    } catch (e: any) {
      console.error("[comodatos] list", e);
      res.status(500).json({ message: e?.message || "Erro ao listar comodatos" });
    }
  });

  // contratos de um cliente (para o cadastro/extrato do cliente)
  app.get("/api/comodatos/cliente/:customerId", ...guard, async (req: Request, res: Response) => {
    try {
      await ensureComodatosSchema();
      const itens = (await carregar()).filter((i: any) => i.customer_id === req.params.customerId);
      res.json(itens);
    } catch (e: any) {
      res.status(500).json({ message: e?.message });
    }
  });

  // busca de clientes para vincular
  app.get("/api/comodatos/clientes-busca", ...guard, async (req: Request, res: Response) => {
    try {
      const q = String(req.query.q || "").trim();
      if (q.length < 2) return res.json([]);
      const dig = q.replace(/\D/g, "");
      const like = "%" + q.toLowerCase() + "%";
      const r: any = await db.execute(sql`
        SELECT id, name, fantasy_name, company_name, cnpj, cpf, city
          FROM customers
         WHERE lower(coalesce(name,'')) LIKE ${like}
            OR lower(coalesce(fantasy_name,'')) LIKE ${like}
            OR lower(coalesce(company_name,'')) LIKE ${like}
            ${dig.length >= 4 ? sql`OR regexp_replace(coalesce(cnpj, cpf, ''), '[^0-9]', '', 'g') LIKE ${"%" + dig + "%"}` : sql``}
         ORDER BY name LIMIT 20`);
      res.json(r.rows || []);
    } catch (e: any) {
      res.status(500).json({ message: e?.message });
    }
  });

  // consulta do CNPJ na Receita (lupa do formulário) + cliente já cadastrado com esse CNPJ
  app.get("/api/comodatos/cnpj/:cnpj", ...guard, async (req: Request, res: Response) => {
    try {
      const dig = String(req.params.cnpj || "").replace(/\D/g, "");
      if (dig.length !== 14) return res.status(400).json({ message: "Informe um CNPJ com 14 dígitos" });
      if (!receitaService.validarCNPJ(dig)) return res.status(400).json({ message: "CNPJ inválido" });
      const cli: any = await db.execute(sql`
        SELECT id, name, fantasy_name, company_name, cnpj, city FROM customers
         WHERE regexp_replace(coalesce(cnpj,''), '[^0-9]', '', 'g') = ${dig}
         ORDER BY is_active DESC NULLS LAST LIMIT 1`);
      const cliente = cli.rows?.[0] || null;
      let receita: any = null, erroReceita: string | null = null;
      try {
        const d = await receitaService.consultarCNPJ(dig);
        if (d) receita = {
          cnpj: receitaService.formatarCNPJ(d.cnpj),
          razaoSocial: d.nome, nomeFantasia: d.fantasia || "",
          endereco: receitaService.formatarEndereco(d),
          cidade: d.municipio, uf: d.uf, cep: d.cep, situacao: d.situacao,
        };
      } catch (e: any) { erroReceita = e?.message || "Falha na consulta"; }
      res.json({ receita, erroReceita, cliente });
    } catch (e: any) {
      res.status(500).json({ message: e?.message });
    }
  });

  // PDF do contrato a partir do formulário (antes de salvar)
  app.post("/api/comodatos/contrato.pdf", ...guard, async (req: Request, res: Response) => {
    try {
      const b = req.body || {};
      const pdf = montarContratoComodatoPdf({
        ...b,
        comodanteRazao: b.comodanteRazao || COMODANTE_PADRAO.razao,
        comodanteCnpj: b.comodanteCnpj || COMODANTE_PADRAO.cnpj,
        signatarioComodante: b.signatarioComodante || SIGNATARIO_COMODANTE_PADRAO,
        usado: b.equipamentoUsado === true || b.equipamentoUsado === "true",
      });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="contrato-comodato.pdf"`);
      res.send(pdf);
    } catch (e: any) {
      console.error("[comodatos] pdf", e);
      res.status(500).json({ message: e?.message || "Erro ao gerar PDF" });
    }
  });

  // DISTRATO: gera o PDF e, se `encerrar`, registra devolução e encerra o contrato
  app.post("/api/comodatos/:id/distrato", ...guard, async (req: Request, res: Response) => {
    try {
      await ensureComodatosSchema();
      const [item] = await carregar(req.params.id);
      if (!item) return res.status(404).json({ message: "Contrato não encontrado" });
      const b = req.body || {};
      const hoje = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
      const dist = {
        dataDistrato: dateOrNull(b.dataDistrato) || hoje,
        dataDevolucao: dateOrNull(b.dataDevolucao) || dateOrNull(b.dataDistrato) || hoje,
        condicao: txt(b.condicao) ?? null,
        motivo: txt(b.motivo) ?? null,
        pendencias: txt(b.pendencias) ?? null,
      };
      if (b.encerrar === true || b.encerrar === "true") {
        await db.execute(sql`
          UPDATE comodato_contracts
             SET status = 'encerrado', data_devolucao = ${dist.dataDevolucao}, condicao_devolucao = ${dist.condicao},
                 distrato_data = ${dist.dataDistrato}, distrato_motivo = ${dist.motivo}, distrato_pendencias = ${dist.pendencias},
                 updated_by = ${userId(req)}, updated_at = now()
           WHERE id = ${req.params.id} AND deleted_at IS NULL`);
      }
      const pdf = montarDistratoComodatoPdf(dadosDoContrato(item), dist);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="distrato-comodato-${item.codigo}.pdf"`);
      res.send(pdf);
    } catch (e: any) {
      console.error("[comodatos] distrato", e);
      res.status(500).json({ message: e?.message || "Erro ao gerar distrato" });
    }
  });

  // PDF de um contrato salvo
  app.get("/api/comodatos/:id/contrato.pdf", ...guard, async (req: Request, res: Response) => {
    try {
      await ensureComodatosSchema();
      const [item] = await carregar(req.params.id);
      if (!item) return res.status(404).json({ message: "Contrato não encontrado" });
      const pdf = montarContratoComodatoPdf(dadosDoContrato(item));
      const nome = `contrato-comodato-${item.codigo}.pdf`;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename="${nome}"`);
      res.send(pdf);
    } catch (e: any) {
      console.error("[comodatos] pdf", e);
      res.status(500).json({ message: e?.message || "Erro ao gerar PDF" });
    }
  });

  app.get("/api/comodatos/:id", ...guard, async (req: Request, res: Response) => {
    try {
      await ensureComodatosSchema();
      const [item] = await carregar(req.params.id);
      if (!item) return res.status(404).json({ message: "Contrato não encontrado" });
      const att: any = await db.execute(sql`
        SELECT id, file_name, mimetype, file_size, descricao, created_at
          FROM comodato_attachments WHERE contract_id = ${req.params.id} ORDER BY created_at`);
      res.json({ ...item, anexosLista: att.rows || [] });
    } catch (e: any) {
      res.status(500).json({ message: e?.message });
    }
  });

  app.post("/api/comodatos", ...guard, async (req: Request, res: Response) => {
    try {
      await ensureComodatosSchema();
      const campos = montarCampos(req.body);
      if (!campos.comodatario_razao) return res.status(400).json({ message: "Informe a razão social do comodatário" });
      campos.created_by = userId(req);
      campos.updated_by = userId(req);
      const cols = Object.keys(campos);
      const r: any = await db.execute(sql`
        INSERT INTO comodato_contracts (${sql.raw(cols.join(", "))})
        VALUES (${sql.join(cols.map((c) => sql`${campos[c]}`), sql`, `)})
        RETURNING id`);
      const id = r.rows?.[0]?.id;
      if (!campos.customer_id) await vincularClientesPorCnpj(id);
      const [item] = await carregar(id);
      res.status(201).json(item);
    } catch (e: any) {
      console.error("[comodatos] create", e);
      res.status(500).json({ message: e?.message || "Erro ao criar contrato" });
    }
  });

  app.patch("/api/comodatos/:id", ...guard, async (req: Request, res: Response) => {
    try {
      await ensureComodatosSchema();
      const campos = montarCampos(req.body);
      if ("comodatario_razao" in campos && !campos.comodatario_razao) {
        return res.status(400).json({ message: "A razão social do comodatário não pode ficar vazia" });
      }
      if (Object.keys(campos).length === 0) return res.status(400).json({ message: "Nada para alterar" });
      campos.updated_by = userId(req);
      const sets = Object.keys(campos).map((c) => sql`${sql.raw(c)} = ${campos[c]}`);
      const r: any = await db.execute(sql`
        UPDATE comodato_contracts SET ${sql.join(sets, sql`, `)}, updated_at = now()
         WHERE id = ${req.params.id} AND deleted_at IS NULL RETURNING id`);
      if (!r.rows?.length) return res.status(404).json({ message: "Contrato não encontrado" });
      if (req.body?.comodatarioCnpj !== undefined && !req.body?.customerId) await vincularClientesPorCnpj(req.params.id);
      const [item] = await carregar(req.params.id);
      res.json(item);
    } catch (e: any) {
      console.error("[comodatos] update", e);
      res.status(500).json({ message: e?.message || "Erro ao salvar contrato" });
    }
  });

  // exclusão lógica (o seed não recria)
  app.delete("/api/comodatos/:id", ...guard, async (req: Request, res: Response) => {
    try {
      await db.execute(sql`
        UPDATE comodato_contracts SET deleted_at = now(), updated_by = ${userId(req)}
         WHERE id = ${req.params.id}`);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ message: e?.message });
    }
  });

  // anexos
  app.post("/api/comodatos/:id/anexos", ...guard, (req: Request, res: Response, next) => {
    upload.single("arquivo")(req as any, res as any, (err: any) => {
      if (err) return res.status(400).json({ message: err?.code === "LIMIT_FILE_SIZE" ? "Arquivo acima de 15MB" : (err?.message || "Falha no upload") });
      next();
    });
  }, async (req: Request, res: Response) => {
    try {
      const f = (req as any).file;
      if (!f) return res.status(400).json({ message: "Envie o arquivo no campo 'arquivo'" });
      const r: any = await db.execute(sql`
        INSERT INTO comodato_attachments (contract_id, file_name, mimetype, file_size, data, descricao, created_by)
        VALUES (${req.params.id}, ${f.originalname}, ${f.mimetype}, ${f.size}, ${f.buffer.toString("base64")},
                ${txt(req.body?.descricao) ?? null}, ${userId(req)})
        RETURNING id, file_name, mimetype, file_size, descricao, created_at`);
      res.status(201).json(r.rows?.[0]);
    } catch (e: any) {
      res.status(500).json({ message: e?.message });
    }
  });

  app.get("/api/comodatos/anexos/:attId", ...guard, async (req: Request, res: Response) => {
    try {
      const r: any = await db.execute(sql`
        SELECT file_name, mimetype, data FROM comodato_attachments WHERE id = ${req.params.attId}`);
      const row = r.rows?.[0];
      if (!row?.data) return res.status(404).json({ message: "Anexo não encontrado" });
      const buf = Buffer.from(String(row.data), "base64");
      const nome = encodeURIComponent(row.file_name || "anexo");
      const disp = req.query.download ? "attachment" : "inline";
      res.setHeader("Content-Type", row.mimetype || "application/octet-stream");
      res.setHeader("Content-Disposition", `${disp}; filename*=UTF-8''${nome}`);
      res.send(buf);
    } catch (e: any) {
      res.status(500).json({ message: e?.message });
    }
  });

  app.delete("/api/comodatos/anexos/:attId", ...guard, async (req: Request, res: Response) => {
    try {
      await db.execute(sql`DELETE FROM comodato_attachments WHERE id = ${req.params.attId}`);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ message: e?.message });
    }
  });
}
