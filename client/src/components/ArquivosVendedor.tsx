// ============================================================================
// PASTA DE ARQUIVOS DO VENDEDOR — 16/out/2026
// ---------------------------------------------------------------------------
// Abre a partir do botão "Arquivos" no card do vendedor (/sellers). É a pasta
// daquele vendedor: contrato, documentos pessoais, cartão CNPJ, dados
// bancários, planilhas de comissão, termos de comodato, fotos...
//
// Backend: server/seller-documents-routes.ts (/api/users/:id/arquivos).
// Só admin, coordenação e administrativo enxergam; excluir é só admin.
// ============================================================================
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@/lib/queryClient";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  FolderOpen, Upload, Download, Trash2, Search, FileText, FileSpreadsheet,
  Image as ImageIcon, File as FileIcon, Loader2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, apiRequestMultipart } from "@/lib/queryClient";
import { useAuth } from "@/hooks/useAuth";

export const CATEGORIA_LABELS: Record<string, string> = {
  contrato: "Contrato",
  documentos_pessoais: "Documentos pessoais",
  empresa_pj: "Empresa / PJ",
  dados_bancarios: "Dados bancários",
  comissoes: "Comissões",
  treinamentos: "Treinamentos",
  equipamentos: "Equipamentos",
  outros: "Outros",
};

const CATEGORIA_CORES: Record<string, string> = {
  contrato: "bg-purple-100 text-purple-800",
  documentos_pessoais: "bg-blue-100 text-blue-800",
  empresa_pj: "bg-indigo-100 text-indigo-800",
  dados_bancarios: "bg-emerald-100 text-emerald-800",
  comissoes: "bg-amber-100 text-amber-800",
  treinamentos: "bg-teal-100 text-teal-800",
  equipamentos: "bg-orange-100 text-orange-800",
  outros: "bg-gray-100 text-gray-800",
};

const ORDEM_CATEGORIAS = Object.keys(CATEGORIA_LABELS);

interface ArquivoVendedor {
  id: string;
  sellerId: string;
  category: string;
  description: string;
  referenceDate: string | null;
  fileName: string;
  mimetype: string | null;
  fileSize: number;
  createdAt: string;
  createdByName: string;
  url: string;
}

const fmtBytes = (n: number) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;

const fmtData = (v: string | null | undefined) =>
  v ? String(v).slice(0, 10).split("-").reverse().join("/") : "";

function IconeArquivo({ mimetype, fileName }: { mimetype: string | null; fileName: string }) {
  const m = (mimetype || "").toLowerCase();
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  if (m.startsWith("image/")) return <ImageIcon className="h-5 w-5 text-blue-600" />;
  if (m.includes("pdf") || ext === "pdf") return <FileText className="h-5 w-5 text-red-600" />;
  if (m.includes("sheet") || m.includes("excel") || ["xlsx", "xls", "csv"].includes(ext)) {
    return <FileSpreadsheet className="h-5 w-5 text-green-600" />;
  }
  if (m.includes("word") || ["doc", "docx"].includes(ext)) return <FileText className="h-5 w-5 text-blue-700" />;
  return <FileIcon className="h-5 w-5 text-gray-500" />;
}

interface Props {
  seller: { id: string; firstName?: string; lastName?: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function ArquivosVendedor({ seller, open, onOpenChange }: Props) {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const isAdmin = (user as any)?.role === "admin";

  const [categoria, setCategoria] = useState<string>("todas");
  const [busca, setBusca] = useState("");
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [novaCategoria, setNovaCategoria] = useState("outros");
  const [descricao, setDescricao] = useState("");
  const [dataRef, setDataRef] = useState("");
  const [excluindo, setExcluindo] = useState<ArquivoVendedor | null>(null);

  const sellerId = seller?.id || "";
  const nome = [seller?.firstName, seller?.lastName].filter(Boolean).join(" ") || "Vendedor";

  const { data, isLoading } = useQuery<{ arquivos: ArquivoVendedor[] }>({
    queryKey: ["/api/users", sellerId, "arquivos"],
    queryFn: () => apiRequest("GET", `/api/users/${sellerId}/arquivos`),
    enabled: open && !!sellerId,
  });

  const arquivos = data?.arquivos || [];

  const visiveis = arquivos.filter((a) => {
    if (categoria !== "todas" && a.category !== categoria) return false;
    if (busca.trim()) {
      const t = busca.trim().toLowerCase();
      if (!a.fileName.toLowerCase().includes(t) && !(a.description || "").toLowerCase().includes(t)) {
        return false;
      }
    }
    return true;
  });

  const porCategoria = ORDEM_CATEGORIAS
    .map((c) => ({ categoria: c, itens: visiveis.filter((a) => a.category === c) }))
    .filter((g) => g.itens.length > 0);

  const limparFormulario = () => {
    setArquivo(null);
    setDescricao("");
    setDataRef("");
    setNovaCategoria("outros");
    const input = document.getElementById("input-arquivo-vendedor") as HTMLInputElement | null;
    if (input) input.value = "";
  };

  const invalidar = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/users", sellerId, "arquivos"] });
    queryClient.invalidateQueries({ queryKey: ["/api/users/arquivos/resumo"] });
  };

  const uploadMutation = useMutation({
    mutationFn: async () => {
      if (!arquivo) throw new Error("Selecione um arquivo");
      const fd = new FormData();
      fd.append("arquivo", arquivo);
      fd.append("category", novaCategoria);
      if (descricao.trim()) fd.append("description", descricao.trim());
      if (dataRef) fd.append("referenceDate", dataRef);
      return apiRequestMultipart("POST", `/api/users/${sellerId}/arquivos`, fd);
    },
    onSuccess: () => {
      toast({ title: "Arquivo enviado", description: "O arquivo foi guardado na pasta do vendedor." });
      limparFormulario();
      invalidar();
    },
    onError: (e: any) => {
      toast({ title: "Falha no envio", description: e?.message || "Não foi possível enviar o arquivo", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (doc: ArquivoVendedor) => apiRequest("DELETE", `/api/users/${sellerId}/arquivos/${doc.id}`),
    onSuccess: () => {
      toast({ title: "Arquivo excluído" });
      setExcluindo(null);
      invalidar();
    },
    onError: (e: any) => {
      toast({ title: "Falha ao excluir", description: e?.message || "Tente novamente", variant: "destructive" });
    },
  });

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-3xl max-h-[88vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FolderOpen className="h-5 w-5 text-amber-600" />
              Arquivos de {nome}
              <Badge variant="secondary" className="ml-1">{arquivos.length}</Badge>
            </DialogTitle>
          </DialogHeader>

          {/* ---------- Envio ---------- */}
          <div className="rounded-lg border bg-muted/30 p-3 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <Label htmlFor="input-arquivo-vendedor" className="text-xs">Arquivo (até 15 MB)</Label>
                <Input
                  id="input-arquivo-vendedor"
                  type="file"
                  className="mt-1"
                  onChange={(e) => setArquivo(e.target.files?.[0] || null)}
                  data-testid="input-arquivo-vendedor"
                />
              </div>
              <div>
                <Label className="text-xs">Pasta</Label>
                <Select value={novaCategoria} onValueChange={setNovaCategoria}>
                  <SelectTrigger className="mt-1" data-testid="select-categoria-arquivo">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ORDEM_CATEGORIAS.map((c) => (
                      <SelectItem key={c} value={c}>{CATEGORIA_LABELS[c]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Descrição (opcional)</Label>
                <Input
                  className="mt-1"
                  placeholder="Ex.: Contrato de prestação de serviço 2026"
                  value={descricao}
                  onChange={(e) => setDescricao(e.target.value)}
                  maxLength={300}
                />
              </div>
              <div>
                <Label className="text-xs">Data de referência (opcional)</Label>
                <Input type="date" className="mt-1" value={dataRef} onChange={(e) => setDataRef(e.target.value)} />
              </div>
            </div>
            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={() => uploadMutation.mutate()}
                disabled={!arquivo || uploadMutation.isPending}
                data-testid="button-enviar-arquivo"
              >
                {uploadMutation.isPending
                  ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Enviando…</>
                  : <><Upload className="h-4 w-4 mr-2" />Enviar arquivo</>}
              </Button>
            </div>
          </div>

          {/* ---------- Filtros ---------- */}
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="Buscar por nome do arquivo ou descrição…"
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
              />
            </div>
            <Select value={categoria} onValueChange={setCategoria}>
              <SelectTrigger className="sm:w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="todas">Todas as pastas</SelectItem>
                {ORDEM_CATEGORIAS.map((c) => (
                  <SelectItem key={c} value={c}>{CATEGORIA_LABELS[c]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* ---------- Lista ---------- */}
          {isLoading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
              Carregando arquivos…
            </div>
          ) : visiveis.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              <FolderOpen className="h-8 w-8 mx-auto mb-2 opacity-40" />
              {arquivos.length === 0
                ? "A pasta deste vendedor ainda está vazia."
                : "Nenhum arquivo corresponde ao filtro."}
            </div>
          ) : (
            <div className="space-y-4">
              {porCategoria.map((grupo) => (
                <div key={grupo.categoria}>
                  <div className="flex items-center gap-2 mb-2">
                    <Badge className={CATEGORIA_CORES[grupo.categoria] || CATEGORIA_CORES.outros}>
                      {CATEGORIA_LABELS[grupo.categoria]}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{grupo.itens.length}</span>
                  </div>
                  <div className="space-y-1">
                    {grupo.itens.map((a) => (
                      <div
                        key={a.id}
                        className="flex items-center gap-3 rounded-md border px-3 py-2 hover:bg-muted/40"
                        data-testid={`arquivo-${a.id}`}
                      >
                        <IconeArquivo mimetype={a.mimetype} fileName={a.fileName} />
                        <div className="min-w-0 flex-1">
                          <a
                            href={a.url}
                            target="_blank"
                            rel="noreferrer"
                            className="block truncate text-sm font-medium hover:underline"
                            title={a.fileName}
                          >
                            {a.fileName}
                          </a>
                          <div className="truncate text-xs text-muted-foreground">
                            {[
                              a.description,
                              a.referenceDate ? `ref. ${fmtData(a.referenceDate)}` : "",
                              fmtBytes(a.fileSize),
                              `enviado em ${fmtData(a.createdAt)}`,
                              a.createdByName ? `por ${a.createdByName}` : "",
                            ].filter(Boolean).join(" · ")}
                          </div>
                        </div>
                        <a href={`${a.url}?download=1`} title="Baixar">
                          <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                            <Download className="h-4 w-4" />
                          </Button>
                        </a>
                        {isAdmin && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 text-red-600 hover:text-red-700 hover:bg-red-50"
                            onClick={() => setExcluindo(a)}
                            title="Excluir"
                            data-testid={`button-excluir-arquivo-${a.id}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!excluindo} onOpenChange={(o) => { if (!o) setExcluindo(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir arquivo?</AlertDialogTitle>
            <AlertDialogDescription>
              "{excluindo?.fileName}" será removido em definitivo da pasta de {nome}. Não há como desfazer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => excluindo && deleteMutation.mutate(excluindo)}
            >
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
