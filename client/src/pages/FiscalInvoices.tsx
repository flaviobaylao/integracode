import { useState, useMemo } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { toast } from '@/hooks/use-toast';
import BackToDashboardButton from '@/components/BackToDashboardButton';
import {
  FileText, Plus, Send, XCircle, Trash2, Eye, RefreshCw,
  CheckCircle2, Clock, AlertTriangle, ShieldCheck, Award,
  Loader2, ChevronLeft, ChevronsUpDown, Check, Printer
} from 'lucide-react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

interface FiscalInvoice {
  id: string;
  invoiceNumber: string;
  series: string;
  issuerName: string;
  issuerCnpj: string;
  issuerIe: string;
  issuerAddress: string;
  issuerUf: string;
  issuerCityCode: string;
  issuerCity: string;
  issuerPhone: string;
  customerName: string;
  customerCnpjCpf: string;
  customerIe: string;
  customerAddress: string;
  customerBairro: string;
  customerCep: string;
  customerCity: string;
  customerUf: string;
  customerPhone: string;
  cfop: string;
  natureOfOperation: string;
  operationType: string;
  omieInstanceId: string;
  status: string;
  environment: string;
  totalProducts: string;
  totalDiscount: string;
  totalFreight: string;
  totalInsurance: string;
  totalOtherExpenses: string;
  totalIcms: string;
  totalPis: string;
  totalCofins: string;
  totalIpi: string;
  totalInvoice: string;
  totalBaseIcms: string;
  totalBaseIcmsSt: string;
  totalIcmsSt: string;
  paymentMethod: string;
  dueDate: string;
  notes: string;
  accessKey: string;
  protocolNumber: string;
  fiscalScenarioId: string;
  emissionDate: string;
  authorizationDate: string;
  createdAt: string;
  updatedAt: string;
  items?: FiscalInvoiceItem[];
  events?: FiscalInvoiceEvent[];
}

interface FiscalInvoiceItem {
  id: string;
  invoiceId: string;
  itemNumber: number;
  productCode: string;
  productName: string;
  ncm: string;
  cfop: string;
  unit: string;
  quantity: string;
  unitPrice: string;
  totalPrice: string;
  discount: string;
  csosn: string;
  cstIcms: string;
  baseIcms: string;
  aliqIcms: string;
  valorIcms: string;
  aliqIpi: string;
  cstPis: string;
  valorPis: string;
  cstCofins: string;
  valorCofins: string;
  valorIpi: string;
}

interface FiscalInvoiceEvent {
  id: string;
  invoiceId: string;
  eventType: string;
  status: string;
  description: string;
  sefazResponse: string;
  createdBy: string;
  createdAt: string;
}

interface FiscalScenario {
  id: string;
  name: string;
  cfop: string;
  natureOfOperation: string;
  taxRegime: string;
  icmsRate: string;
  pisRate: string;
  cofinsRate: string;
  ipiRate: string;
  isActive: boolean;
  createdAt: string;
}

interface DigitalCertificate {
  id: string;
  companyName: string;
  cnpj: string;
  serialNumber: string;
  issuer: string;
  validFrom: string;
  validUntil: string;
  certificateType: string;
  isActive: boolean;
  createdAt: string;
}

interface DashboardStats {
  totalInvoices: number;
  byStatus: {
    draft: number;
    authorized: number;
    cancelled: number;
    rejected: number;
  };
  totalValue: number;
  totalScenarios: number;
  activeCertificates: number;
}

const statusConfig: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline'; className: string }> = {
  draft: { label: 'Rascunho', variant: 'secondary', className: 'bg-yellow-100 text-yellow-800 border-yellow-300' },
  authorized: { label: 'Autorizada', variant: 'default', className: 'bg-green-100 text-green-800 border-green-300' },
  cancelled: { label: 'Cancelada', variant: 'destructive', className: 'bg-red-100 text-red-800 border-red-300' },
  rejected: { label: 'Rejeitada', variant: 'outline', className: 'bg-orange-100 text-orange-800 border-orange-300' },
  processing: { label: 'Processando', variant: 'default', className: 'bg-blue-100 text-blue-800 border-blue-300' },
};

function getStatusBadge(status: string) {
  const config = statusConfig[status] || { label: status, variant: 'outline' as const, className: '' };
  return <Badge variant={config.variant} className={config.className}>{config.label}</Badge>;
}

function formatCurrency(value: string | number) {
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return 'R$ 0,00';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(num);
}

function formatDate(dateString: string) {
  if (!dateString) return '-';
  return new Date(dateString).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function formatDateTime(dateString: string) {
  if (!dateString) return '-';
  return new Date(dateString).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function generateDanfePdf(invoice: FiscalInvoice) {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = 210;
  const margin = 7;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;
  const centerX = pageWidth / 2;

  const isHomologacao = invoice.environment === 'homologacao';

  const fmtCur = (v: string | number) => {
    const n = typeof v === 'string' ? parseFloat(v) : v;
    if (isNaN(n)) return '0,00';
    return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  const fmtQty = (v: string | number) => {
    const n = typeof v === 'string' ? parseFloat(v) : v;
    if (isNaN(n)) return '0';
    return n.toLocaleString('pt-BR', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  };
  const fmtDateOnly = (d: string) => {
    if (!d) return '';
    return new Date(d).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  };
  const fmtTimeOnly = (d: string) => {
    if (!d) return '';
    return new Date(d).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
  const fmtDateTime = (d: string) => {
    if (!d) return '';
    return new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  };

  const drawBox = (x: number, yp: number, w: number, h: number) => {
    doc.setDrawColor(0);
    doc.setLineWidth(0.3);
    doc.rect(x, yp, w, h);
  };

  const drawField = (label: string, value: string, x: number, yp: number, w: number, h: number = 10) => {
    drawBox(x, yp, w, h);
    doc.setFontSize(5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100);
    doc.text(label, x + 1, yp + 3);
    doc.setFontSize(7);
    doc.setTextColor(0);
    doc.setFont('helvetica', 'bold');
    const lines = doc.splitTextToSize(value || '-', w - 2);
    doc.text(lines.slice(0, 2), x + 1, yp + 7);
  };

  const emitName = invoice.issuerName || 'EMPRESA EMITENTE';
  const emitCnpj = invoice.issuerCnpj || '';
  const emitIe = invoice.issuerIe || '';
  const emitAddress = invoice.issuerAddress || '';
  const emitPhone = invoice.issuerPhone || '';
  const emitCity = invoice.issuerCity || '';
  const emitUf = invoice.issuerUf || '';
  const nfNum = invoice.invoiceNumber || '0';
  const nfSerie = invoice.series || '1';
  const emissionDate = invoice.emissionDate || invoice.createdAt;
  const accessKey = invoice.accessKey || '';
  const formattedKey = accessKey ? accessKey.replace(/(.{4})/g, '$1 ').trim() : '';

  // ========== 1. CANHOTO (Receipt stub) ==========
  const canhotH = 22;
  drawBox(margin, y, contentWidth - 40, canhotH);
  doc.setFontSize(5.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(0);
  const canhotText = `RECEBEMOS DE ${emitName} OS PRODUTOS E/OU SERVIÇOS CONSTANTES DA NOTA FISCAL ELETRÔNICA INDICADA ABAIXO.`;
  const canhotLines = doc.splitTextToSize(canhotText, contentWidth - 46);
  doc.text(canhotLines, margin + 2, y + 4);
  doc.setFontSize(5.5);
  doc.text(`EMISSÃO: ${fmtDateOnly(emissionDate)}    VALOR TOTAL: R$ ${fmtCur(invoice.totalInvoice || '0')}    DESTINATÁRIO: ${invoice.customerName || ''}`, margin + 2, y + 10);
  const destAddrShort = invoice.customerAddress || '';
  if (destAddrShort) {
    doc.setFontSize(5);
    const addrShort = doc.splitTextToSize(destAddrShort, contentWidth - 46);
    doc.text(addrShort.slice(0, 1), margin + 2, y + 13);
  }
  doc.setFontSize(5);
  doc.text('DATA DE RECEBIMENTO', margin + 2, y + 17);
  doc.setLineWidth(0.2);
  doc.line(margin + 30, y + 17.5, margin + 50, y + 17.5);
  doc.text('IDENTIFICAÇÃO E ASSINATURA DO RECEBEDOR', margin + 52, y + 17);
  doc.line(margin + 95, y + 17.5, contentWidth - 42, y + 17.5);

  drawBox(contentWidth - 40 + margin, y, 40, canhotH);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.text('NF-e', contentWidth - 40 + margin + 20, y + 7, { align: 'center' });
  doc.setFontSize(9);
  doc.text(`Nº ${nfNum}`, contentWidth - 40 + margin + 20, y + 13, { align: 'center' });
  doc.setFontSize(7);
  doc.text(`Série ${nfSerie}`, contentWidth - 40 + margin + 20, y + 18, { align: 'center' });

  y += canhotH;

  doc.setLineDashPattern([2, 2], 0);
  doc.setLineWidth(0.2);
  doc.line(margin, y + 1, pageWidth - margin, y + 1);
  doc.setLineDashPattern([], 0);
  y += 3;

  // ========== 2. HEADER (3 columns: Emitente | DANFE | Chave de Acesso) ==========
  const headerH = 32;
  const col1W = 80;
  const col2W = 42;
  const col3HeaderW = contentWidth - col1W - col2W;

  drawBox(margin, y, col1W, headerH);
  drawBox(margin + col1W, y, col2W, headerH);
  drawBox(margin + col1W + col2W, y, col3HeaderW, headerH);

  doc.setFontSize(5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100);
  doc.text('IDENTIFICAÇÃO DO EMITENTE', margin + col1W / 2, y + 3, { align: 'center' });
  doc.setTextColor(0);
  doc.setFontSize(7);
  doc.setFont('helvetica', 'bold');
  const emitNameLines = doc.splitTextToSize(emitName, col1W - 4);
  doc.text(emitNameLines.slice(0, 2), margin + 2, y + 8);
  const emitNameH = Math.min(emitNameLines.length, 2) * 3.5;
  doc.setFontSize(6);
  doc.setFont('helvetica', 'normal');
  const emitAddrLines = doc.splitTextToSize(emitAddress, col1W - 4);
  doc.text(emitAddrLines.slice(0, 2), margin + 2, y + 8 + emitNameH + 1);
  const cityLine = emitCity && emitUf ? `${emitCity} - ${emitUf}` : '';
  const phoneLine = emitPhone ? `Fone: ${emitPhone}` : '';
  const cityPhoneLine = [cityLine, phoneLine].filter(Boolean).join('  ');
  if (cityPhoneLine) {
    doc.text(cityPhoneLine, margin + 2, y + 8 + emitNameH + 1 + Math.min(emitAddrLines.length, 2) * 3 + 1);
  }

  const danfeCenterX = margin + col1W + col2W / 2;
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('DANFE', danfeCenterX, y + 7, { align: 'center' });
  doc.setFontSize(5);
  doc.setFont('helvetica', 'normal');
  doc.text('Documento Auxiliar', danfeCenterX, y + 10.5, { align: 'center' });
  doc.text('da Nota Fiscal', danfeCenterX, y + 13, { align: 'center' });
  doc.text('Eletrônica', danfeCenterX, y + 15.5, { align: 'center' });
  doc.setFontSize(6);
  const isEntrada = invoice.operationType === 'entrada';
  doc.text(`0 - ENTRADA`, danfeCenterX - 2, y + 19, { align: 'center' });
  doc.text(`1 - SAÍDA`, danfeCenterX - 2, y + 22, { align: 'center' });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text(isEntrada ? '0' : '1', danfeCenterX + 18, y + 21, { align: 'center' });
  doc.setLineWidth(0.3);
  doc.rect(danfeCenterX + 14, y + 17, 8, 6);
  doc.setFontSize(7);
  doc.text(`Nº ${nfNum}`, danfeCenterX, y + 26, { align: 'center' });
  doc.text(`Série ${nfSerie}`, danfeCenterX, y + 29, { align: 'center' });
  doc.setFontSize(5.5);
  doc.setFont('helvetica', 'normal');
  doc.text('Folha 1/1', danfeCenterX, y + 32, { align: 'center' });

  const keyColX = margin + col1W + col2W;
  doc.setFontSize(5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100);
  doc.text('CHAVE DE ACESSO', keyColX + col3HeaderW / 2, y + 3, { align: 'center' });
  doc.setTextColor(0);
  doc.setFontSize(6);
  doc.setFont('helvetica', 'bold');
  if (formattedKey) {
    const keyLines = doc.splitTextToSize(formattedKey, col3HeaderW - 4);
    doc.text(keyLines, keyColX + 2, y + 8);
  } else {
    doc.text('N/A', keyColX + 2, y + 8);
  }
  doc.setFontSize(5);
  doc.setFont('helvetica', 'normal');
  doc.text('Consulta de autenticidade no portal nacional da NF-e', keyColX + 2, y + 18);
  doc.text('www.nfe.fazenda.gov.br/portal', keyColX + 2, y + 21);
  doc.text('ou no site da Sefaz Autorizadora', keyColX + 2, y + 24);

  y += headerH;

  // ========== 3. NATUREZA DA OPERAÇÃO + PROTOCOLO ==========
  const natW = contentWidth * 0.55;
  const protW = contentWidth - natW;
  drawField('NATUREZA DA OPERAÇÃO', invoice.natureOfOperation || 'Venda de Producao do Estabelecimento', margin, y, natW, 10);
  drawField('PROTOCOLO DE AUTORIZAÇÃO DE USO', `${invoice.protocolNumber || ''}    -    ${fmtDateTime(invoice.authorizationDate || emissionDate)}`, margin + natW, y, protW, 10);
  y += 10;

  // ========== 4. INSCRIÇÃO ESTADUAL + IE SUBST. TRIB. + CNPJ ==========
  const ieW = contentWidth * 0.35;
  const ieStW = contentWidth * 0.35;
  const cnpjW = contentWidth - ieW - ieStW;
  drawField('INSCRIÇÃO ESTADUAL', emitIe, margin, y, ieW, 10);
  drawField('INSCRIÇÃO ESTADUAL DO SUBST. TRIBUT.', '', margin + ieW, y, ieStW, 10);
  drawField('CNPJ', emitCnpj, margin + ieW + ieStW, y, cnpjW, 10);
  y += 10;

  // ========== HOMOLOGAÇÃO WARNING ==========
  if (isHomologacao) {
    drawBox(margin, y, contentWidth, 7);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(200, 0, 0);
    doc.text('SEM VALOR FISCAL - EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO', centerX, y + 5, { align: 'center' });
    doc.setTextColor(0);
    y += 7;
  }

  // ========== 5. DESTINATÁRIO / REMETENTE ==========
  drawBox(margin, y, contentWidth, 5);
  doc.setFontSize(6);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(0);
  doc.text('DESTINATÁRIO / REMETENTE', margin + 2, y + 3.5);
  y += 5;

  const destNameW = contentWidth * 0.55;
  const destCnpjW = contentWidth * 0.25;
  const destDateW = contentWidth - destNameW - destCnpjW;
  drawField('NOME / RAZÃO SOCIAL', invoice.customerName || '', margin, y, destNameW, 10);
  drawField('CNPJ / CPF', invoice.customerCnpjCpf || '', margin + destNameW, y, destCnpjW, 10);
  drawField('DATA DA EMISSÃO', fmtDateOnly(emissionDate), margin + destNameW + destCnpjW, y, destDateW, 10);
  y += 10;

  const destAddrW = contentWidth * 0.45;
  const destBairroW = contentWidth * 0.2;
  const destCepW = contentWidth * 0.15;
  const destExitDateW = contentWidth - destAddrW - destBairroW - destCepW;
  drawField('ENDEREÇO', invoice.customerAddress || '', margin, y, destAddrW, 10);
  drawField('BAIRRO / DISTRITO', invoice.customerBairro || '', margin + destAddrW, y, destBairroW, 10);
  drawField('CEP', invoice.customerCep || '', margin + destAddrW + destBairroW, y, destCepW, 10);
  drawField('DATA DA SAÍDA/ENTRADA', fmtDateOnly(emissionDate), margin + destAddrW + destBairroW + destCepW, y, destExitDateW, 10);
  y += 10;

  const destMuniW = contentWidth * 0.35;
  const destUfW = contentWidth * 0.05;
  const destFoneW = contentWidth * 0.2;
  const destIeW = contentWidth * 0.2;
  const destHourW = contentWidth - destMuniW - destUfW - destFoneW - destIeW;
  drawField('MUNICÍPIO', invoice.customerCity || '', margin, y, destMuniW, 10);
  drawField('UF', invoice.customerUf || '', margin + destMuniW, y, destUfW, 10);
  drawField('FONE / FAX', invoice.customerPhone || '', margin + destMuniW + destUfW, y, destFoneW, 10);
  drawField('INSCRIÇÃO ESTADUAL', invoice.customerIe || '', margin + destMuniW + destUfW + destFoneW, y, destIeW, 10);
  drawField('HORA DA SAÍDA/ENTRADA', fmtTimeOnly(emissionDate), margin + destMuniW + destUfW + destFoneW + destIeW, y, destHourW, 10);
  y += 10;

  // ========== 6. FATURA / DUPLICATA ==========
  drawBox(margin, y, contentWidth, 5);
  doc.setFontSize(6);
  doc.setFont('helvetica', 'bold');
  doc.text('FATURA / DUPLICATA', margin + 2, y + 3.5);
  y += 5;

  const payLabels: Record<string, string> = {
    'a_vista': 'À Vista', 'a_prazo': 'A Prazo', 'pix': 'PIX',
    'boleto': 'Boleto', 'cartao': 'Cartão', 'dinheiro': 'Dinheiro'
  };
  const fatW = contentWidth / 4;
  drawField('Num.', '001', margin, y, fatW, 12);
  drawField('Venc.', invoice.dueDate ? fmtDateOnly(invoice.dueDate) : fmtDateOnly(emissionDate), margin + fatW, y, fatW, 12);
  drawField('Valor', `R$ ${fmtCur(invoice.totalInvoice || '0')}`, margin + fatW * 2, y, fatW, 12);
  drawField('Forma Pagamento', payLabels[invoice.paymentMethod] || invoice.paymentMethod || '-', margin + fatW * 3, y, fatW, 12);
  y += 12;

  // ========== 7. CÁLCULO DO IMPOSTO (2 rows x 7 columns) ==========
  drawBox(margin, y, contentWidth, 5);
  doc.setFontSize(6);
  doc.setFont('helvetica', 'bold');
  doc.text('CÁLCULO DO IMPOSTO', margin + 2, y + 3.5);
  y += 5;

  const col7 = contentWidth / 7;
  drawField('BASE DE CÁLCULO DO ICMS', fmtCur(invoice.totalBaseIcms || '0'), margin, y, col7, 10);
  drawField('VALOR DO ICMS', fmtCur(invoice.totalIcms || '0'), margin + col7, y, col7, 10);
  drawField('BASE DE CÁLC. ICMS S.T.', fmtCur(invoice.totalBaseIcmsSt || '0'), margin + col7 * 2, y, col7, 10);
  drawField('VALOR DO ICMS SUBST.', fmtCur(invoice.totalIcmsSt || '0'), margin + col7 * 3, y, col7, 10);
  drawField('VALOR IMP. IMPORTAÇÃO', '0,00', margin + col7 * 4, y, col7, 10);
  drawField('VALOR DO PIS', fmtCur(invoice.totalPis || '0'), margin + col7 * 5, y, col7, 10);
  drawField('VALOR TOTAL DOS PRODUTOS', fmtCur(invoice.totalProducts || '0'), margin + col7 * 6, y, col7, 10);
  y += 10;

  drawField('VALOR DO FRETE', fmtCur(invoice.totalFreight || '0'), margin, y, col7, 10);
  drawField('VALOR DO SEGURO', fmtCur(invoice.totalInsurance || '0'), margin + col7, y, col7, 10);
  drawField('DESCONTO', fmtCur(invoice.totalDiscount || '0'), margin + col7 * 2, y, col7, 10);
  drawField('OUTRAS DESPESAS', fmtCur(invoice.totalOtherExpenses || '0'), margin + col7 * 3, y, col7, 10);
  drawField('VALOR TOTAL DO IPI', fmtCur(invoice.totalIpi || '0'), margin + col7 * 4, y, col7, 10);
  drawField('VALOR DA COFINS', fmtCur(invoice.totalCofins || '0'), margin + col7 * 5, y, col7, 10);
  drawField('VALOR TOTAL DA NOTA', fmtCur(invoice.totalInvoice || '0'), margin + col7 * 6, y, col7, 10);
  y += 10;

  // ========== 8. TRANSPORTADOR / VOLUMES TRANSPORTADOS ==========
  drawBox(margin, y, contentWidth, 5);
  doc.setFontSize(6);
  doc.setFont('helvetica', 'bold');
  doc.text('TRANSPORTADOR / VOLUMES TRANSPORTADOS', margin + 2, y + 3.5);
  y += 5;

  const trNameW = contentWidth * 0.3;
  const trFreteW = contentWidth * 0.15;
  const trAnttW = contentWidth * 0.15;
  const trPlacaW = contentWidth * 0.15;
  const trUfTrW = contentWidth * 0.05;
  const trCnpjTrW = contentWidth - trNameW - trFreteW - trAnttW - trPlacaW - trUfTrW;
  drawField('NOME / RAZÃO SOCIAL', '', margin, y, trNameW, 10);
  drawField('FRETE POR CONTA', '(9) Sem Frete', margin + trNameW, y, trFreteW, 10);
  drawField('CÓDIGO ANTT', '', margin + trNameW + trFreteW, y, trAnttW, 10);
  drawField('PLACA DO VEÍCULO', '', margin + trNameW + trFreteW + trAnttW, y, trPlacaW, 10);
  drawField('UF', '', margin + trNameW + trFreteW + trAnttW + trPlacaW, y, trUfTrW, 10);
  drawField('CNPJ / CPF', '', margin + trNameW + trFreteW + trAnttW + trPlacaW + trUfTrW, y, trCnpjTrW, 10);
  y += 10;

  const trQtdW = contentWidth / 6;
  drawField('QUANTIDADE', '', margin, y, trQtdW, 10);
  drawField('ESPÉCIE', '', margin + trQtdW, y, trQtdW, 10);
  drawField('MARCA', '', margin + trQtdW * 2, y, trQtdW, 10);
  drawField('NUMERAÇÃO', '', margin + trQtdW * 3, y, trQtdW, 10);
  drawField('PESO BRUTO (KG)', '', margin + trQtdW * 4, y, trQtdW, 10);
  drawField('PESO LÍQUIDO (KG)', '', margin + trQtdW * 5, y, trQtdW, 10);
  y += 10;

  // ========== 9. DADOS DOS PRODUTOS / SERVIÇOS ==========
  drawBox(margin, y, contentWidth, 5);
  doc.setFontSize(6);
  doc.setFont('helvetica', 'bold');
  doc.text('DADOS DOS PRODUTOS / SERVIÇOS', margin + 2, y + 3.5);
  y += 5;

  const items = invoice.items || [];
  const tableHead = [['CÓDIGO\nPRODUTO', 'DESCRIÇÃO DO PRODUTO / SERVIÇO', 'NCM/SH', 'O/CSOSN', 'CFOP', 'UN', 'QUANT', 'VALOR\nUNIT', 'VALOR\nTOTAL', 'B.CÁLC\nICMS', 'VALOR\nICMS', 'VALOR\nIPI', 'ALÍQ.\nICMS', 'ALÍQ.\nIPI']];
  const tableBody = items.map((item: FiscalInvoiceItem) => [
    item.productCode || '',
    isHomologacao ? 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL' : (item.productName || ''),
    item.ncm || '',
    item.csosn || item.cstIcms || '0102',
    item.cfop || invoice.cfop || '',
    item.unit || 'UN',
    fmtQty(item.quantity),
    fmtCur(item.unitPrice),
    fmtCur(item.totalPrice),
    fmtCur(item.baseIcms || '0'),
    fmtCur(item.valorIcms || '0'),
    fmtCur(item.valorIpi || '0'),
    item.aliqIcms ? `${item.aliqIcms}` : '0,00',
    item.aliqIpi ? `${item.aliqIpi}` : '0,00',
  ]);

  autoTable(doc, {
    startY: y,
    head: tableHead,
    body: tableBody,
    theme: 'grid',
    styles: { fontSize: 5, cellPadding: 1, lineWidth: 0.2, lineColor: [0, 0, 0], overflow: 'linebreak' },
    headStyles: { fillColor: [240, 240, 240], textColor: [0, 0, 0], fontStyle: 'bold', fontSize: 4.5, cellPadding: 1 },
    columnStyles: {
      0: { cellWidth: 14 },
      1: { cellWidth: 42 },
      2: { cellWidth: 14 },
      3: { cellWidth: 10 },
      4: { cellWidth: 10 },
      5: { cellWidth: 8 },
      6: { cellWidth: 14, halign: 'right' },
      7: { cellWidth: 14, halign: 'right' },
      8: { cellWidth: 14, halign: 'right' },
      9: { cellWidth: 14, halign: 'right' },
      10: { cellWidth: 14, halign: 'right' },
      11: { cellWidth: 12, halign: 'right' },
      12: { cellWidth: 8, halign: 'right' },
      13: { cellWidth: 8, halign: 'right' },
    },
    margin: { left: margin, right: margin },
    showHead: 'everyPage',
  });

  y = (doc as any).lastAutoTable.finalY + 2;

  const pageHeight = doc.internal.pageSize.getHeight();
  if (y > pageHeight - 60) {
    doc.addPage();
    y = margin;
  }

  // ========== 10. DADOS ADICIONAIS (2 columns) ==========
  drawBox(margin, y, contentWidth, 5);
  doc.setFontSize(6);
  doc.setFont('helvetica', 'bold');
  doc.text('DADOS ADICIONAIS', margin + 2, y + 3.5);
  y += 5;

  const infoW = contentWidth * 0.65;
  const fiscoW = contentWidth - infoW;
  const infoH = 20;
  drawBox(margin, y, infoW, infoH);
  drawBox(margin + infoW, y, fiscoW, infoH);

  doc.setFontSize(5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100);
  doc.text('INFORMAÇÕES COMPLEMENTARES', margin + 2, y + 3);
  doc.text('RESERVADO AO FISCO', margin + infoW + 2, y + 3);
  doc.setTextColor(0);

  doc.setFontSize(5.5);
  const notesText = invoice.notes || '';
  const noteLines = doc.splitTextToSize(notesText, infoW - 4);
  doc.text(noteLines.slice(0, 6), margin + 2, y + 6);

  y += infoH;

  // ========== 11. FOOTER ==========
  doc.setFontSize(5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100);
  const printDate = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  doc.text(`Impresso em ${printDate}`, margin, y + 4);
  doc.text('Sistema Integra - Beba Honest', pageWidth - margin, y + 4, { align: 'right' });
  doc.setTextColor(0);

  const fileName = `DANFE_${nfNum}_${invoice.environment === 'homologacao' ? 'HOM' : 'PROD'}.pdf`;
  doc.save(fileName);
}

export default function FiscalInvoices() {
  const [activeTab, setActiveTab] = useState('invoices');
  const [statusFilter, setStatusFilter] = useState('all');
  const [envFilter, setEnvFilter] = useState('all');
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showDetailDialog, setShowDetailDialog] = useState(false);
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [showCertDialog, setShowCertDialog] = useState(false);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null);
  const [cancelJustification, setCancelJustification] = useState('');
  const [certFile, setCertFile] = useState<File | null>(null);
  const [certPassword, setCertPassword] = useState('');
  const [newInvoice, setNewInvoice] = useState({
    customerName: '',
    customerCnpjCpf: '',
    customerIe: '',
    customerAddress: '',
    customerBairro: '',
    customerCep: '',
    customerCity: '',
    customerUf: '',
    customerPhone: '',
    fiscalScenarioId: '',
    cfop: '',
    natureOfOperation: '',
    paymentMethod: 'a_vista',
    environment: 'homologacao',
    notes: '',
    operationType: 'saida',
    omieInstanceId: '',
    issuerName: '',
    issuerCnpj: '',
    issuerIe: '',
    issuerAddress: '',
    issuerUf: '',
    issuerCityCode: '',
    issuerCity: '',
    issuerPhone: '',
    items: [] as Array<{ productCode: string; productName: string; ncm: string; cfop: string; quantity: string; unitPrice: string }>,
  });
  const [newItem, setNewItem] = useState({ productCode: '', productName: '', ncm: '', cfop: '', quantity: '1', unitPrice: '0' });
  const [customerSearchOpen, setCustomerSearchOpen] = useState(false);
  const [customerSearch, setCustomerSearch] = useState('');
  const [productSearchOpen, setProductSearchOpen] = useState(false);
  const [productSearch, setProductSearch] = useState('');

  const { data: companyDataList } = useQuery<any[]>({
    queryKey: ['/api/nfe/company-data'],
    enabled: showCreateDialog,
  });

  const { data: allCustomers, isLoading: loadingCustomers } = useQuery<any[]>({
    queryKey: ['/api/customers/all-for-sales'],
    enabled: showCreateDialog,
  });

  const { data: allProducts, isLoading: loadingProducts } = useQuery<any[]>({
    queryKey: ['/api/products'],
    enabled: showCreateDialog,
  });

  const filteredCustomers = useMemo(() => {
    if (!allCustomers) return [];
    const q = customerSearch.toLowerCase();
    if (!q) return allCustomers.slice(0, 50);
    return allCustomers.filter(c =>
      (c.name || '').toLowerCase().includes(q) ||
      (c.companyName || '').toLowerCase().includes(q) ||
      (c.fantasyName || '').toLowerCase().includes(q) ||
      (c.cnpj || '').includes(q) ||
      (c.cpf || '').includes(q)
    ).slice(0, 50);
  }, [allCustomers, customerSearch]);

  const filteredProducts = useMemo(() => {
    if (!allProducts) return [];
    const q = productSearch.toLowerCase();
    if (!q) return allProducts.filter((p: any) => p.isActive !== false).slice(0, 50);
    return allProducts.filter((p: any) =>
      p.isActive !== false && (
        (p.name || '').toLowerCase().includes(q) ||
        (p.omieCode || '').toLowerCase().includes(q) ||
        (p.omieCodigo || '').toLowerCase().includes(q)
      )
    ).slice(0, 50);
  }, [allProducts, productSearch]);

  const { data: stats, isLoading: loadingStats } = useQuery<DashboardStats>({
    queryKey: ['/api/fiscal-dashboard'],
  });

  const buildInvoiceUrl = () => {
    const params = new URLSearchParams();
    if (statusFilter !== 'all') params.set('status', statusFilter);
    if (envFilter !== 'all') params.set('environment', envFilter);
    const qs = params.toString();
    return `/api/fiscal-invoices${qs ? `?${qs}` : ''}`;
  };

  const { data: invoices, isLoading: loadingInvoices } = useQuery<FiscalInvoice[]>({
    queryKey: ['/api/fiscal-invoices', statusFilter, envFilter],
    queryFn: () => fetch(buildInvoiceUrl(), { credentials: 'include' }).then(r => r.json()),
  });

  const { data: invoiceDetail, isLoading: loadingDetail } = useQuery<FiscalInvoice>({
    queryKey: ['/api/fiscal-invoices', selectedInvoiceId],
    queryFn: () => fetch(`/api/fiscal-invoices/${selectedInvoiceId}`, { credentials: 'include' }).then(r => r.json()),
    enabled: !!selectedInvoiceId && showDetailDialog,
  });

  const { data: scenarios } = useQuery<FiscalScenario[]>({
    queryKey: ['/api/fiscal-scenarios'],
  });

  const { data: certificates } = useQuery<DigitalCertificate[]>({
    queryKey: ['/api/digital-certificates'],
  });

  const createMutation = useMutation({
    mutationFn: (data: any) => apiRequest('POST', '/api/fiscal-invoices', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/fiscal-invoices'] });
      queryClient.invalidateQueries({ queryKey: ['/api/fiscal-dashboard'] });
      setShowCreateDialog(false);
      resetNewInvoice();
      toast({ title: 'NF-e criada', description: 'Nota fiscal criada com sucesso.' });
    },
    onError: (err: any) => {
      toast({ title: 'Erro ao criar NF-e', description: err.message, variant: 'destructive' });
    },
  });

  const emitMutation = useMutation({
    mutationFn: (id: string) => apiRequest('POST', `/api/fiscal-invoices/${id}/emit`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/fiscal-invoices'] });
      queryClient.invalidateQueries({ queryKey: ['/api/fiscal-dashboard'] });
      toast({ title: 'NF-e emitida', description: 'Nota fiscal enviada para a SEFAZ.' });
    },
    onError: (err: any) => {
      toast({ title: 'Erro ao emitir NF-e', description: err.message, variant: 'destructive' });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: ({ id, justification }: { id: string; justification: string }) =>
      apiRequest('POST', `/api/fiscal-invoices/${id}/cancel`, { justification }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/fiscal-invoices'] });
      queryClient.invalidateQueries({ queryKey: ['/api/fiscal-dashboard'] });
      setShowCancelDialog(false);
      setCancelJustification('');
      toast({ title: 'NF-e cancelada', description: 'Nota fiscal cancelada com sucesso.' });
    },
    onError: (err: any) => {
      toast({ title: 'Erro ao cancelar NF-e', description: err.message, variant: 'destructive' });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/fiscal-invoices/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/fiscal-invoices'] });
      queryClient.invalidateQueries({ queryKey: ['/api/fiscal-dashboard'] });
      toast({ title: 'NF-e excluída', description: 'Nota fiscal excluída com sucesso.' });
    },
    onError: (err: any) => {
      toast({ title: 'Erro ao excluir NF-e', description: err.message, variant: 'destructive' });
    },
  });

  const createCertMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      const res = await fetch('/api/digital-certificates', {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: 'Erro ao cadastrar certificado' }));
        throw new Error(err.message || 'Erro ao cadastrar certificado');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/digital-certificates'] });
      queryClient.invalidateQueries({ queryKey: ['/api/fiscal-dashboard'] });
      setShowCertDialog(false);
      setCertFile(null);
      setCertPassword('');
      toast({ title: 'Certificado cadastrado', description: 'Certificado digital importado com sucesso. Dados extraídos automaticamente do arquivo.' });
    },
    onError: (err: any) => {
      toast({ title: 'Erro ao cadastrar certificado', description: err.message, variant: 'destructive' });
    },
  });

  const deleteCertMutation = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/digital-certificates/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/digital-certificates'] });
      queryClient.invalidateQueries({ queryKey: ['/api/fiscal-dashboard'] });
      toast({ title: 'Certificado excluído', description: 'Certificado digital excluído com sucesso.' });
    },
    onError: (err: any) => {
      toast({ title: 'Erro ao excluir certificado', description: err.message, variant: 'destructive' });
    },
  });

  function handleCreateCert() {
    if (!certFile) {
      toast({ title: 'Arquivo obrigatório', description: 'Selecione o arquivo PFX/P12 do certificado digital.', variant: 'destructive' });
      return;
    }
    if (!certPassword) {
      toast({ title: 'Senha obrigatória', description: 'Informe a senha do certificado digital.', variant: 'destructive' });
      return;
    }
    const formData = new FormData();
    formData.append('pfxFile', certFile);
    formData.append('password', certPassword);
    createCertMutation.mutate(formData);
  }

  function resetNewInvoice() {
    setNewInvoice({
      customerName: '', customerCnpjCpf: '', customerIe: '', customerAddress: '',
      customerBairro: '', customerCep: '', customerCity: '', customerUf: '', customerPhone: '',
      fiscalScenarioId: '', cfop: '', natureOfOperation: '', paymentMethod: 'a_vista',
      environment: 'homologacao', notes: '', operationType: 'saida',
      omieInstanceId: '', issuerName: '', issuerCnpj: '', issuerIe: '',
      issuerAddress: '', issuerUf: '', issuerCityCode: '', issuerCity: '', issuerPhone: '',
      items: [],
    });
    setNewItem({ productCode: '', productName: '', ncm: '', cfop: '', quantity: '1', unitPrice: '0' });
    setCustomerSearch('');
    setProductSearch('');
  }

  function handleAddItem() {
    if (!newItem.productName || !newItem.unitPrice) return;
    setNewInvoice(prev => ({
      ...prev,
      items: [...prev.items, { ...newItem }],
    }));
    setNewItem({ productCode: '', productName: '', ncm: '', cfop: '', quantity: '1', unitPrice: '0' });
  }

  function handleRemoveItem(index: number) {
    setNewInvoice(prev => ({
      ...prev,
      items: prev.items.filter((_, i) => i !== index),
    }));
  }

  function handleInstanceSelect(instanceId: string) {
    const company = companyDataList?.find((c: any) => c.instanceId === instanceId);
    if (company) {
      setNewInvoice(p => ({
        ...p,
        omieInstanceId: instanceId,
        issuerName: company.name,
        issuerCnpj: company.cnpj,
        issuerIe: company.ie,
        issuerAddress: company.address,
        issuerUf: company.uf,
        issuerCityCode: company.cityCode,
        issuerCity: company.city,
        issuerPhone: company.phone,
      }));
    }
  }

  function handleCreateInvoice() {
    if (!newInvoice.omieInstanceId) {
      toast({ title: 'Instância obrigatória', description: 'Selecione a empresa emitente.', variant: 'destructive' });
      return;
    }
    if (!newInvoice.customerName || !newInvoice.customerCnpjCpf) {
      toast({ title: 'Campos obrigatórios', description: 'Preencha o nome e CPF/CNPJ do cliente.', variant: 'destructive' });
      return;
    }
    if (newInvoice.items.length === 0) {
      toast({ title: 'Itens obrigatórios', description: 'Adicione pelo menos um item à NF-e.', variant: 'destructive' });
      return;
    }
    const payload = {
      ...newInvoice,
      items: newInvoice.items.map(item => ({
        ...item,
        totalPrice: (parseFloat(item.quantity || '0') * parseFloat(item.unitPrice || '0')).toString(),
      })),
    };
    createMutation.mutate(payload);
  }

  function handleScenarioSelect(scenarioId: string) {
    const scenario = scenarios?.find(s => s.id === scenarioId);
    if (scenario) {
      setNewInvoice(prev => ({
        ...prev,
        fiscalScenarioId: scenarioId,
        cfop: scenario.cfop,
        natureOfOperation: scenario.natureOfOperation,
      }));
    }
  }

  function openDetail(id: string) {
    setSelectedInvoiceId(id);
    setShowDetailDialog(true);
  }

  function openCancel(id: string) {
    setSelectedInvoiceId(id);
    setShowCancelDialog(true);
  }

  function isCertificateExpired(validUntil: string) {
    if (!validUntil) return false;
    return new Date(validUntil) < new Date();
  }

  function isCertificateExpiringSoon(validUntil: string) {
    if (!validUntil) return false;
    const days30 = new Date();
    days30.setDate(days30.getDate() + 30);
    return new Date(validUntil) < days30 && new Date(validUntil) >= new Date();
  }

  return (
    <div className="p-6 space-y-6">
      <BackToDashboardButton />

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-center gap-3">
          <FileText className="h-8 w-8 text-blue-600" />
          <div>
            <h1 className="text-3xl font-bold">Faturamento NF-e</h1>
            <p className="text-muted-foreground">Gestão de notas fiscais eletrônicas</p>
          </div>
        </div>
        <Button onClick={() => setShowCreateDialog(true)} className="bg-blue-600 hover:bg-blue-700">
          <Plus className="w-4 h-4 mr-2" />
          Nova NF-e
        </Button>
      </div>

      {/* Dashboard Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total NF-es</CardTitle>
            <FileText className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{loadingStats ? '...' : (stats?.totalInvoices || 0)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Autorizadas</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{loadingStats ? '...' : (stats?.byStatus?.authorized || 0)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Rascunho</CardTitle>
            <Clock className="h-4 w-4 text-yellow-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-yellow-600">{loadingStats ? '...' : (stats?.byStatus?.draft || 0)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Valor Total Autorizado</CardTitle>
            <Award className="h-4 w-4 text-blue-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">{loadingStats ? '...' : formatCurrency(stats?.totalValue || 0)}</div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="invoices">Notas Fiscais</TabsTrigger>
          <TabsTrigger value="scenarios">Cenários Fiscais</TabsTrigger>
          <TabsTrigger value="certificates">Certificados Digitais</TabsTrigger>
        </TabsList>

        {/* Tab: Notas Fiscais */}
        <TabsContent value="invoices" className="space-y-4">
          <div className="flex flex-wrap gap-3 items-end">
            <div>
              <Label className="text-xs">Status</Label>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="draft">Rascunho</SelectItem>
                  <SelectItem value="authorized">Autorizada</SelectItem>
                  <SelectItem value="cancelled">Cancelada</SelectItem>
                  <SelectItem value="rejected">Rejeitada</SelectItem>
                  <SelectItem value="processing">Processando</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Ambiente</Label>
              <Select value={envFilter} onValueChange={setEnvFilter}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="homologacao">Homologação</SelectItem>
                  <SelectItem value="producao">Produção</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button variant="outline" size="sm" onClick={() => { setStatusFilter('all'); setEnvFilter('all'); }}>
              <RefreshCw className="w-4 h-4 mr-1" /> Limpar
            </Button>
          </div>

          <Card>
            <CardContent className="p-0">
              {loadingInvoices ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : !invoices?.length ? (
                <div className="text-center py-12 text-muted-foreground">
                  <FileText className="h-12 w-12 mx-auto mb-3 opacity-30" />
                  <p>Nenhuma nota fiscal encontrada</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Número</TableHead>
                      <TableHead>Cliente</TableHead>
                      <TableHead>CFOP</TableHead>
                      <TableHead>Valor Total</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Ambiente</TableHead>
                      <TableHead>Data</TableHead>
                      <TableHead>Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invoices.map(inv => (
                      <TableRow key={inv.id} className="cursor-pointer hover:bg-muted/50" onClick={() => openDetail(inv.id)}>
                        <TableCell className="font-mono font-medium">{inv.invoiceNumber || '-'}</TableCell>
                        <TableCell>
                          <div>
                            <p className="font-medium text-sm">{inv.customerName}</p>
                            <p className="text-xs text-muted-foreground">{inv.customerCnpjCpf}</p>
                          </div>
                        </TableCell>
                        <TableCell>{inv.cfop || '-'}</TableCell>
                        <TableCell className="font-medium">{formatCurrency(inv.totalInvoice || '0')}</TableCell>
                        <TableCell>{getStatusBadge(inv.status)}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={inv.environment === 'producao' ? 'border-red-300 text-red-700' : 'border-blue-300 text-blue-700'}>
                            {inv.environment === 'producao' ? 'Produção' : 'Homologação'}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm">{formatDate(inv.createdAt)}</TableCell>
                        <TableCell>
                          <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                            <Button variant="ghost" size="icon" title="Ver detalhes" onClick={() => openDetail(inv.id)}>
                              <Eye className="h-4 w-4" />
                            </Button>
                            {(inv.status === 'draft' || inv.status === 'rejected') && (
                              <Button variant="ghost" size="icon" title="Emitir NF-e" onClick={() => emitMutation.mutate(inv.id)} disabled={emitMutation.isPending}>
                                <Send className="h-4 w-4 text-blue-600" />
                              </Button>
                            )}
                            {inv.status === 'authorized' && (
                              <Button variant="ghost" size="icon" title="Gerar DANFE" onClick={async () => {
                                try {
                                  const res = await fetch(`/api/fiscal-invoices/${inv.id}`, { credentials: 'include' });
                                  const fullInvoice = await res.json();
                                  generateDanfePdf(fullInvoice);
                                } catch { toast({ title: 'Erro', description: 'Não foi possível gerar o DANFE', variant: 'destructive' }); }
                              }}>
                                <Printer className="h-4 w-4 text-green-600" />
                              </Button>
                            )}
                            {inv.status === 'authorized' && (
                              <Button variant="ghost" size="icon" title="Cancelar NF-e" onClick={() => openCancel(inv.id)}>
                                <XCircle className="h-4 w-4 text-red-600" />
                              </Button>
                            )}
                            {inv.status !== 'authorized' && (
                              <Button variant="ghost" size="icon" title="Excluir NF-e" onClick={() => {
                                if (confirm('Tem certeza que deseja excluir esta NF-e?')) deleteMutation.mutate(inv.id);
                              }}>
                                <Trash2 className="h-4 w-4 text-red-500" />
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab: Cenários Fiscais */}
        <TabsContent value="scenarios" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Cenários Fiscais (CFOP)</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {!scenarios?.length ? (
                <div className="text-center py-8 text-muted-foreground">Nenhum cenário fiscal cadastrado</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Nome</TableHead>
                      <TableHead>CFOP</TableHead>
                      <TableHead>Natureza da Operação</TableHead>
                      <TableHead>Regime Tributário</TableHead>
                      <TableHead>ICMS</TableHead>
                      <TableHead>PIS</TableHead>
                      <TableHead>COFINS</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {scenarios.map(sc => (
                      <TableRow key={sc.id}>
                        <TableCell className="font-medium">{sc.name}</TableCell>
                        <TableCell className="font-mono">{sc.cfop}</TableCell>
                        <TableCell>{sc.natureOfOperation}</TableCell>
                        <TableCell>{sc.taxRegime || '-'}</TableCell>
                        <TableCell>{sc.icmsRate ? `${sc.icmsRate}%` : '-'}</TableCell>
                        <TableCell>{sc.pisRate ? `${sc.pisRate}%` : '-'}</TableCell>
                        <TableCell>{sc.cofinsRate ? `${sc.cofinsRate}%` : '-'}</TableCell>
                        <TableCell>
                          <Badge variant={sc.isActive ? 'default' : 'secondary'} className={sc.isActive ? 'bg-green-100 text-green-800' : ''}>
                            {sc.isActive ? 'Ativo' : 'Inativo'}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab: Certificados Digitais */}
        <TabsContent value="certificates" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-lg flex items-center gap-2">
                <ShieldCheck className="h-5 w-5" />
                Certificados Digitais
              </CardTitle>
              <Button size="sm" onClick={() => setShowCertDialog(true)}>
                <Plus className="h-4 w-4 mr-1" /> Novo Certificado
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              {!certificates?.length ? (
                <div className="text-center py-8 text-muted-foreground">
                  <p>Nenhum certificado digital cadastrado</p>
                  <Button variant="outline" size="sm" className="mt-4" onClick={() => setShowCertDialog(true)}>
                    <Plus className="h-4 w-4 mr-1" /> Cadastrar Certificado
                  </Button>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Empresa</TableHead>
                      <TableHead>CNPJ</TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead>Emissor</TableHead>
                      <TableHead>Validade</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="w-16">Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {certificates.map(cert => (
                      <TableRow key={cert.id}>
                        <TableCell className="font-medium">{cert.companyName}</TableCell>
                        <TableCell className="font-mono text-sm">{cert.cnpj}</TableCell>
                        <TableCell>{cert.certificateType}</TableCell>
                        <TableCell>{cert.issuer || '-'}</TableCell>
                        <TableCell>
                          <div className="text-sm">
                            {cert.validFrom && <span>{formatDate(cert.validFrom)} - </span>}
                            {cert.validUntil && <span>{formatDate(cert.validUntil)}</span>}
                          </div>
                        </TableCell>
                        <TableCell>
                          {isCertificateExpired(cert.validUntil) ? (
                            <Badge variant="destructive">Expirado</Badge>
                          ) : isCertificateExpiringSoon(cert.validUntil) ? (
                            <Badge className="bg-orange-100 text-orange-800 border-orange-300">Expirando</Badge>
                          ) : cert.isActive ? (
                            <Badge className="bg-green-100 text-green-800 border-green-300">Ativo</Badge>
                          ) : (
                            <Badge variant="secondary">Inativo</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => { if (confirm('Tem certeza que deseja excluir este certificado?')) deleteCertMutation.mutate(cert.id); }}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Create Invoice Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Nova Nota Fiscal Eletrônica</DialogTitle>
            <DialogDescription>Preencha os dados da NF-e. Itens podem ser adicionados abaixo.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Empresa Emitente (Instância) *</Label>
              <Select value={newInvoice.omieInstanceId} onValueChange={handleInstanceSelect}>
                <SelectTrigger className={!newInvoice.omieInstanceId ? 'border-orange-300' : 'border-green-300'}>
                  <SelectValue placeholder="Selecione a empresa emitente..." />
                </SelectTrigger>
                <SelectContent>
                  {companyDataList?.map((company: any) => (
                    <SelectItem key={company.instanceId} value={company.instanceId}>
                      <div className="flex items-center gap-2">
                        <span className="inline-block w-3 h-3 rounded-full" style={{ backgroundColor: company.tagColor || '#3B82F6' }} />
                        <span className="font-medium">{company.instanceName}</span>
                        <span className="text-xs text-muted-foreground">- {company.name}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {newInvoice.issuerCnpj && (
                <div className="text-xs text-muted-foreground bg-gray-50 rounded p-2 mt-1">
                  <strong>{newInvoice.issuerName}</strong> | CNPJ: {newInvoice.issuerCnpj} | IE: {newInvoice.issuerIe} | {newInvoice.issuerAddress}
                </div>
              )}
            </div>
            <div className="space-y-2">
              <Label>Cliente *</Label>
              <Popover open={customerSearchOpen} onOpenChange={setCustomerSearchOpen} modal={true}>
                <PopoverTrigger asChild>
                  <Button variant="outline" role="combobox" aria-expanded={customerSearchOpen} className="w-full justify-between font-normal h-auto min-h-[40px] text-left">
                    {newInvoice.customerName ? (
                      <div className="flex flex-col items-start gap-0.5">
                        <span className="text-sm">{newInvoice.customerName}</span>
                        {newInvoice.customerCnpjCpf && <span className="text-xs text-muted-foreground">{newInvoice.customerCnpjCpf}</span>}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">Buscar cliente por nome, razão social ou CNPJ/CPF...</span>
                    )}
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[500px] p-0 z-[10000]" align="start" sideOffset={4} onOpenAutoFocus={(e) => e.preventDefault()}>
                  <Command shouldFilter={false}>
                    <CommandInput placeholder="Digite para buscar cliente..." value={customerSearch} onValueChange={setCustomerSearch} />
                    <CommandList>
                      <CommandEmpty>{loadingCustomers ? 'Carregando clientes...' : 'Nenhum cliente encontrado.'}</CommandEmpty>
                      <CommandGroup>
                        {filteredCustomers.map((customer: any) => {
                          const displayName = customer.companyName || customer.fantasyName || customer.name;
                          const doc = customer.cnpj || customer.cpf || '';
                          return (
                            <CommandItem
                              key={customer.id}
                              value={customer.id}
                              onSelect={() => {
                                const address = [customer.address, customer.addressNumber, customer.addressComplement].filter(Boolean).join(', ');
                                setNewInvoice(p => ({
                                  ...p,
                                  customerName: displayName,
                                  customerCnpjCpf: doc,
                                  customerIe: customer.ie || customer.stateRegistration || '',
                                  customerAddress: address || '',
                                  customerBairro: customer.neighborhood || customer.bairro || '',
                                  customerCep: customer.zipCode || customer.cep || '',
                                  customerCity: customer.city || '',
                                  customerUf: customer.state || customer.uf || '',
                                  customerPhone: customer.phone || customer.phoneMain || '',
                                }));
                                setCustomerSearchOpen(false);
                                setCustomerSearch('');
                              }}
                            >
                              <Check className={`mr-2 h-4 w-4 ${newInvoice.customerName === displayName ? 'opacity-100' : 'opacity-0'}`} />
                              <div className="flex flex-col">
                                <span className="text-sm font-medium">{displayName}</span>
                                <span className="text-xs text-muted-foreground">
                                  {customer.fantasyName && customer.companyName ? `${customer.fantasyName} • ` : ''}
                                  {doc ? doc : 'Sem documento'}
                                  {customer.city ? ` • ${customer.city}/${customer.state || ''}` : ''}
                                </span>
                              </div>
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Nome/Razão Social</Label>
                <Input value={newInvoice.customerName} onChange={e => setNewInvoice(p => ({ ...p, customerName: e.target.value }))} placeholder="Preenchido ao selecionar cliente" />
              </div>
              <div>
                <Label>CPF/CNPJ</Label>
                <Input value={newInvoice.customerCnpjCpf} onChange={e => setNewInvoice(p => ({ ...p, customerCnpjCpf: e.target.value }))} placeholder="Preenchido ao selecionar cliente" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Cenário Fiscal</Label>
                <Select value={newInvoice.fiscalScenarioId} onValueChange={handleScenarioSelect}>
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione..." />
                  </SelectTrigger>
                  <SelectContent>
                    {scenarios?.filter(s => s.isActive).map(s => (
                      <SelectItem key={s.id} value={s.id}>{s.name} ({s.cfop})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>CFOP</Label>
                <Input value={newInvoice.cfop} onChange={e => setNewInvoice(p => ({ ...p, cfop: e.target.value }))} placeholder="5102" />
              </div>
            </div>
            <div>
              <Label>Natureza da Operação</Label>
              <Input value={newInvoice.natureOfOperation} onChange={e => setNewInvoice(p => ({ ...p, natureOfOperation: e.target.value }))} placeholder="Venda de mercadoria" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Forma de Pagamento</Label>
                <Select value={newInvoice.paymentMethod} onValueChange={v => setNewInvoice(p => ({ ...p, paymentMethod: v }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="a_vista">À Vista</SelectItem>
                    <SelectItem value="boleto">Boleto</SelectItem>
                    <SelectItem value="pix">PIX</SelectItem>
                    <SelectItem value="cartao_credito">Cartão de Crédito</SelectItem>
                    <SelectItem value="cartao_debito">Cartão de Débito</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Ambiente</Label>
                <Select value={newInvoice.environment} onValueChange={v => setNewInvoice(p => ({ ...p, environment: v }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="homologacao">Homologação</SelectItem>
                    <SelectItem value="producao">Produção</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Observações</Label>
              <Textarea value={newInvoice.notes} onChange={e => setNewInvoice(p => ({ ...p, notes: e.target.value }))} placeholder="Observações adicionais..." rows={2} />
            </div>

            {/* Items section */}
            <div className="border rounded-lg p-4 space-y-3">
              <h4 className="font-medium text-sm">Itens da NF-e</h4>
              {newInvoice.items.length > 0 && (
                <div className="space-y-2">
                  {newInvoice.items.map((item, idx) => (
                    <div key={idx} className="flex items-center gap-2 text-sm bg-muted/50 rounded p-2">
                      <span className="flex-1">{item.productName}</span>
                      <span className="text-muted-foreground">Qtd: {item.quantity}</span>
                      <span className="font-medium">{formatCurrency(parseFloat(item.unitPrice) * parseFloat(item.quantity))}</span>
                      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => handleRemoveItem(idx)}>
                        <Trash2 className="h-3 w-3 text-red-500" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <div className="space-y-2">
                <Popover open={productSearchOpen} onOpenChange={setProductSearchOpen} modal={true}>
                  <PopoverTrigger asChild>
                    <Button variant="outline" role="combobox" aria-expanded={productSearchOpen} className="w-full justify-between font-normal h-auto min-h-[36px] text-left text-sm">
                      {newItem.productName ? (
                        <div className="flex items-center gap-2">
                          <span>{newItem.productName}</span>
                          {newItem.productCode && <span className="text-xs text-muted-foreground">({newItem.productCode})</span>}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">Buscar produto por nome ou código...</span>
                      )}
                      <ChevronsUpDown className="ml-2 h-3 w-3 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[450px] p-0 z-[10000]" align="start" sideOffset={4} onOpenAutoFocus={(e) => e.preventDefault()}>
                    <Command shouldFilter={false}>
                      <CommandInput placeholder="Digite para buscar produto..." value={productSearch} onValueChange={setProductSearch} />
                      <CommandList>
                        <CommandEmpty>{loadingProducts ? 'Carregando produtos...' : 'Nenhum produto encontrado.'}</CommandEmpty>
                        <CommandGroup>
                          {filteredProducts.map((product: any) => (
                            <CommandItem
                              key={product.id}
                              value={product.id}
                              onSelect={() => {
                                setNewItem(p => ({
                                  ...p,
                                  productName: product.name,
                                  productCode: product.omieCode || product.omieCodigo || '',
                                  unitPrice: product.price || '0',
                                  cfop: newInvoice.cfop || p.cfop,
                                }));
                                setProductSearchOpen(false);
                                setProductSearch('');
                              }}
                            >
                              <Check className={`mr-2 h-4 w-4 ${newItem.productName === product.name ? 'opacity-100' : 'opacity-0'}`} />
                              <div className="flex flex-col">
                                <span className="text-sm font-medium">{product.name}</span>
                                <span className="text-xs text-muted-foreground">
                                  {product.omieCode || product.omieCodigo || 'Sem código'} • {formatCurrency(product.price)} • Estoque: {product.stock ?? '-'}
                                </span>
                              </div>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
                <div className="grid grid-cols-4 gap-2">
                  <Input placeholder="Código" value={newItem.productCode} onChange={e => setNewItem(p => ({ ...p, productCode: e.target.value }))} className="text-sm" />
                  <Input placeholder="Qtd" type="number" value={newItem.quantity} onChange={e => setNewItem(p => ({ ...p, quantity: e.target.value }))} className="text-sm" />
                  <Input placeholder="Preço unit." type="number" step="0.01" value={newItem.unitPrice} onChange={e => setNewItem(p => ({ ...p, unitPrice: e.target.value }))} className="text-sm" />
                  <Button variant="outline" size="sm" onClick={handleAddItem}>
                    <Plus className="h-4 w-4 mr-1" /> Adicionar
                  </Button>
                </div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>Cancelar</Button>
            <Button onClick={handleCreateInvoice} disabled={createMutation.isPending} className="bg-blue-600 hover:bg-blue-700">
              {createMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Criar NF-e
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Invoice Detail Dialog */}
      <Dialog open={showDetailDialog} onOpenChange={(open) => { setShowDetailDialog(open); if (!open) setSelectedInvoiceId(null); }}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setShowDetailDialog(false)}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              Detalhes da NF-e {invoiceDetail?.invoiceNumber ? `#${invoiceDetail.invoiceNumber}` : ''}
            </DialogTitle>
          </DialogHeader>
          {loadingDetail ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : invoiceDetail ? (
            <div className="space-y-6">
              {/* Emitente info */}
              {invoiceDetail.issuerName && (
                <div className="bg-blue-50 rounded-lg p-3 border border-blue-200">
                  <p className="text-xs font-semibold text-blue-700 mb-1">EMITENTE</p>
                  <p className="font-medium text-sm">{invoiceDetail.issuerName}</p>
                  <p className="text-xs text-muted-foreground">CNPJ: {invoiceDetail.issuerCnpj} | IE: {invoiceDetail.issuerIe} | {invoiceDetail.issuerAddress}</p>
                </div>
              )}

              {/* Info grid */}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <div>
                  <p className="text-xs text-muted-foreground">Status</p>
                  <div className="mt-1">{getStatusBadge(invoiceDetail.status)}</div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Ambiente</p>
                  <Badge variant="outline" className={invoiceDetail.environment === 'producao' ? 'border-red-300 text-red-700' : 'border-blue-300 text-blue-700'}>
                    {invoiceDetail.environment === 'producao' ? 'Produção' : 'Homologação'}
                  </Badge>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Valor Total</p>
                  <p className="text-lg font-bold">{formatCurrency(invoiceDetail.totalInvoice || '0')}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Cliente</p>
                  <p className="font-medium">{invoiceDetail.customerName}</p>
                  <p className="text-xs text-muted-foreground">{invoiceDetail.customerCnpjCpf}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">CFOP</p>
                  <p className="font-mono">{invoiceDetail.cfop || '-'}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Natureza da Operação</p>
                  <p>{invoiceDetail.natureOfOperation || '-'}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Pagamento</p>
                  <p>{invoiceDetail.paymentMethod || '-'}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Data de Criação</p>
                  <p>{formatDateTime(invoiceDetail.createdAt)}</p>
                </div>
                {invoiceDetail.accessKey && (
                  <div className="col-span-full">
                    <p className="text-xs text-muted-foreground">Chave de Acesso</p>
                    <p className="font-mono text-xs break-all">{invoiceDetail.accessKey}</p>
                  </div>
                )}
                {invoiceDetail.protocolNumber && (
                  <div>
                    <p className="text-xs text-muted-foreground">Protocolo</p>
                    <p className="font-mono text-sm">{invoiceDetail.protocolNumber}</p>
                  </div>
                )}
              </div>

              {/* Items */}
              {invoiceDetail.items && invoiceDetail.items.length > 0 && (
                <div>
                  <h4 className="font-medium mb-2">Itens ({invoiceDetail.items.length})</h4>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>#</TableHead>
                        <TableHead>Produto</TableHead>
                        <TableHead>NCM</TableHead>
                        <TableHead>Qtd</TableHead>
                        <TableHead>Valor Unit.</TableHead>
                        <TableHead>Total</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {invoiceDetail.items.map(item => (
                        <TableRow key={item.id}>
                          <TableCell>{item.itemNumber}</TableCell>
                          <TableCell>
                            <p className="font-medium text-sm">{item.productName}</p>
                            {item.productCode && <p className="text-xs text-muted-foreground">{item.productCode}</p>}
                          </TableCell>
                          <TableCell className="font-mono text-sm">{item.ncm || '-'}</TableCell>
                          <TableCell>{item.quantity}</TableCell>
                          <TableCell>{formatCurrency(item.unitPrice)}</TableCell>
                          <TableCell className="font-medium">{formatCurrency(item.totalPrice)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {/* Events Timeline */}
              {invoiceDetail.events && invoiceDetail.events.length > 0 && (
                <div>
                  <h4 className="font-medium mb-2">Histórico de Eventos</h4>
                  <div className="space-y-3">
                    {invoiceDetail.events.map(evt => (
                      <div key={evt.id} className="flex gap-3 items-start border-l-2 border-muted pl-4 pb-3">
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <Badge variant={evt.status === 'success' ? 'default' : 'destructive'} className={evt.status === 'success' ? 'bg-green-100 text-green-800' : ''}>
                              {evt.eventType}
                            </Badge>
                            <span className="text-xs text-muted-foreground">{formatDateTime(evt.createdAt)}</span>
                          </div>
                          <p className="text-sm mt-1">{evt.description}</p>
                          {evt.sefazResponse && (
                            <pre className="text-xs bg-muted rounded p-2 mt-1 overflow-x-auto max-h-24">{evt.sefazResponse}</pre>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Action buttons */}
              <div className="flex gap-2 justify-end border-t pt-4">
                {invoiceDetail.status === 'authorized' && (
                  <Button variant="outline" onClick={() => generateDanfePdf(invoiceDetail)} className="border-green-300 text-green-700 hover:bg-green-50">
                    <Printer className="h-4 w-4 mr-2" /> Gerar DANFE
                  </Button>
                )}
                {(invoiceDetail.status === 'draft' || invoiceDetail.status === 'rejected') && (
                  <Button onClick={() => emitMutation.mutate(invoiceDetail.id)} disabled={emitMutation.isPending} className="bg-blue-600 hover:bg-blue-700">
                    {emitMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
                    Emitir NF-e
                  </Button>
                )}
                {invoiceDetail.status === 'authorized' && (
                  <Button variant="destructive" onClick={() => openCancel(invoiceDetail.id)}>
                    <XCircle className="h-4 w-4 mr-2" /> Cancelar NF-e
                  </Button>
                )}
                {invoiceDetail.status !== 'authorized' && (
                  <Button variant="outline" className="text-red-600 border-red-300" onClick={() => {
                    if (confirm('Tem certeza que deseja excluir esta NF-e?')) {
                      deleteMutation.mutate(invoiceDetail.id);
                      setShowDetailDialog(false);
                    }
                  }}>
                    <Trash2 className="h-4 w-4 mr-2" /> Excluir
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">Nota fiscal não encontrada</div>
          )}
        </DialogContent>
      </Dialog>

      {/* Cancel Dialog */}
      <Dialog open={showCancelDialog} onOpenChange={(open) => { setShowCancelDialog(open); if (!open) setCancelJustification(''); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <AlertTriangle className="h-5 w-5" /> Cancelar NF-e
            </DialogTitle>
            <DialogDescription>Esta ação é irreversível. A NF-e autorizada será cancelada junto à SEFAZ.</DialogDescription>
          </DialogHeader>
          <div>
            <Label>Justificativa (mínimo 15 caracteres) *</Label>
            <Textarea
              value={cancelJustification}
              onChange={e => setCancelJustification(e.target.value)}
              placeholder="Informe o motivo do cancelamento..."
              rows={3}
            />
            <p className="text-xs text-muted-foreground mt-1">{cancelJustification.length}/15 caracteres mínimos</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCancelDialog(false)}>Voltar</Button>
            <Button
              variant="destructive"
              disabled={cancelJustification.length < 15 || cancelMutation.isPending}
              onClick={() => {
                if (selectedInvoiceId) {
                  cancelMutation.mutate({ id: selectedInvoiceId, justification: cancelJustification });
                }
              }}
            >
              {cancelMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Confirmar Cancelamento
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Certificate Dialog */}
      <Dialog open={showCertDialog} onOpenChange={(open) => { setShowCertDialog(open); if (!open) { setCertFile(null); setCertPassword(''); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5" /> Importar Certificado Digital
            </DialogTitle>
            <DialogDescription>
              Importe o arquivo PFX/P12 do certificado digital A1. Os dados da empresa, CNPJ, validade e emissor serão extraídos automaticamente do certificado.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Arquivo do Certificado (PFX/P12) *</Label>
              <div className="mt-1">
                <Input
                  type="file"
                  accept=".pfx,.p12"
                  onChange={e => setCertFile(e.target.files?.[0] || null)}
                  className="cursor-pointer"
                />
              </div>
              {certFile && (
                <p className="text-xs text-muted-foreground mt-1">
                  Arquivo selecionado: {certFile.name} ({(certFile.size / 1024).toFixed(1)} KB)
                </p>
              )}
            </div>
            <div>
              <Label>Senha do Certificado *</Label>
              <Input
                type="password"
                value={certPassword}
                onChange={e => setCertPassword(e.target.value)}
                placeholder="Senha de acesso ao certificado"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCertDialog(false)}>Cancelar</Button>
            <Button onClick={handleCreateCert} disabled={createCertMutation.isPending || !certFile || !certPassword}>
              {createCertMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Importar Certificado
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
