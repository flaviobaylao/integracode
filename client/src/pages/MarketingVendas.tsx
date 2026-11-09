// ============================================================================
// MARKETING DE VENDAS — 09/nov/2026
// Pasta oficial de material de venda para toda a equipe: tabelas de preços,
// portfólio, posts e material de PDV. Vendedor e telemarketing veem, baixam e
// mandam para o cliente; gestor (admin, coordenação, administrativo) publica,
// troca a versão e tira do ar. Servidor: server/marketing-vendas-routes.ts.
// ============================================================================
import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";

type Material = {
  id: string;
  titulo: string;
  categoria: string;
  descricao: string;
  ordem: number;
  ativo: boolean;
  fileName: string;
  mimetype: string | null;
  fileSize: number;
  createdAt: string;
  updatedAt: string;
  createdByName: string;
  url: string;
};

const CATEGORIAS: { id: string; label: string; icon: string }[] = [
  { id: "tabelas", label: "Tabelas de preços", icon: "fas fa-tags" },
  { id: "portfolio", label: "Portfólio", icon: "fas fa-book-open" },
  { id: "posts", label: "Posts e cards", icon: "fas fa-image" },
  { id: "pdv", label: "PDV e mockups", icon: "fas fa-store" },
  { id: "outros", label: "Outros", icon: "fas fa-folder" },
];

const ehImagem = (m: Material) => String(m.mimetype || "").startsWith("image/");
const tamanho = (b: number) => (b >= 1024 * 1024 ? (b / 1024 / 1024).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB");
const dataBR = (s: string) => (s ? new Date(s).toLocaleDateString("pt-BR") : "");
const comDownload = (url: string) => url + (url.includes("?") ? "&" : "?") + "download=1";

async function enviarArquivo(method: string, url: string, fd: FormData) {
  const r = await fetch(url, { method, body: fd, credentials: "include" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.message || "Falha no envio");
  return j;
}
async function enviarJson(method: string, url: string, body?: any) {
  const r = await fetch(url, {
    method, credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.message || "Falha na operação");
  return j;
}

export default function MarketingVendas() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { user } = useAuth();
  const [filtro, setFiltro] = useState<string>("todos");
  const [mostrarInativos, setMostrarInativos] = useState(false);
  const [aberto, setAberto] = useState<Material | null>(null);
  const [editando, setEditando] = useState<Material | null>(null);
  const [novo, setNovo] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const trocarRef = useRef<HTMLInputElement>(null);
  const [trocandoId, setTrocandoId] = useState<string | null>(null);

  // formulário (novo e edição)
  const [fTitulo, setFTitulo] = useState("");
  const [fCategoria, setFCategoria] = useState("tabelas");
  const [fDescricao, setFDescricao] = useState("");
  const [fOrdem, setFOrdem] = useState("0");
  const [fArquivo, setFArquivo] = useState<File | null>(null);

  const q = useQuery<{ materiais: Material[]; podeGerir: boolean }>({
    queryKey: ["/api/marketing-vendas", mostrarInativos],
    queryFn: async () => {
      const r = await fetch(`/api/marketing-vendas${mostrarInativos ? "?todos=1" : ""}`, { credentials: "include", cache: "no-store" });
      if (!r.ok) throw new Error("Falha ao carregar");
      return r.json();
    },
  });
  const materiais = q.data?.materiais || [];
  const podeGerir = !!q.data?.podeGerir;
  const ehAdmin = user?.role === "admin";
  const recarregar = () => qc.invalidateQueries({ queryKey: ["/api/marketing-vendas"] });

  const contagem = useMemo(() => {
    const c: Record<string, number> = {};
    for (const m of materiais) c[m.categoria] = (c[m.categoria] || 0) + 1;
    return c;
  }, [materiais]);

  const grupos = useMemo(() => {
    return CATEGORIAS
      .filter((c) => filtro === "todos" || c.id === filtro)
      .map((c) => ({ ...c, itens: materiais.filter((m) => m.categoria === c.id) }))
      .filter((g) => g.itens.length > 0);
  }, [materiais, filtro]);

  function abrirNovo() {
    setFTitulo(""); setFCategoria(filtro !== "todos" ? filtro : "tabelas"); setFDescricao(""); setFOrdem("0"); setFArquivo(null);
    setNovo(true);
  }
  function abrirEdicao(m: Material) {
    setFTitulo(m.titulo); setFCategoria(m.categoria); setFDescricao(m.descricao || ""); setFOrdem(String(m.ordem || 0));
    setEditando(m);
  }

  async function publicar() {
    if (!fArquivo) { toast({ title: "Escolha o arquivo", variant: "destructive" }); return; }
    setSalvando(true);
    try {
      const fd = new FormData();
      fd.append("arquivo", fArquivo);
      fd.append("titulo", fTitulo);
      fd.append("categoria", fCategoria);
      fd.append("descricao", fDescricao);
      fd.append("ordem", fOrdem || "0");
      await enviarArquivo("POST", "/api/marketing-vendas", fd);
      toast({ title: "Material publicado", description: "Já aparece para toda a equipe." });
      setNovo(false);
      recarregar();
    } catch (e: any) {
      toast({ title: "Não publicou", description: e?.message, variant: "destructive" });
    } finally { setSalvando(false); }
  }

  async function salvarEdicao() {
    if (!editando) return;
    setSalvando(true);
    try {
      await enviarJson("PATCH", `/api/marketing-vendas/${editando.id}`, {
        titulo: fTitulo, categoria: fCategoria, descricao: fDescricao, ordem: Number(fOrdem || 0),
      });
      toast({ title: "Material atualizado" });
      setEditando(null);
      recarregar();
    } catch (e: any) {
      toast({ title: "Não salvou", description: e?.message, variant: "destructive" });
    } finally { setSalvando(false); }
  }

  async function alternarAtivo(m: Material) {
    try {
      await enviarJson("PATCH", `/api/marketing-vendas/${m.id}`, { ativo: !m.ativo });
      toast({ title: m.ativo ? "Tirado do ar" : "Voltou para a equipe" });
      recarregar();
    } catch (e: any) {
      toast({ title: "Não alterou", description: e?.message, variant: "destructive" });
    }
  }

  async function excluir(m: Material) {
    if (!window.confirm(`Excluir "${m.titulo}" de vez? Não dá para desfazer.`)) return;
    try {
      await enviarJson("DELETE", `/api/marketing-vendas/${m.id}`);
      toast({ title: "Material excluído" });
      recarregar();
    } catch (e: any) {
      toast({ title: "Não excluiu", description: e?.message, variant: "destructive" });
    }
  }

  async function trocarArquivo(file: File | undefined) {
    const id = trocandoId;
    setTrocandoId(null);
    if (!file || !id) return;
    try {
      const fd = new FormData();
      fd.append("arquivo", file);
      await enviarArquivo("PUT", `/api/marketing-vendas/${id}/arquivo`, fd);
      toast({ title: "Nova versão publicada", description: "A equipe já vê o arquivo novo." });
      recarregar();
    } catch (e: any) {
      toast({ title: "Não substituiu", description: e?.message, variant: "destructive" });
    }
  }

  // Compartilhar: no celular abre o menu do sistema (WhatsApp etc.) com o
  // arquivo; no computador, baixa o arquivo para anexar.
  async function compartilhar(m: Material) {
    try {
      const nav: any = navigator;
      if (nav.share && nav.canShare) {
        const r = await fetch(m.url, { credentials: "include" });
        const blob = await r.blob();
        const file = new File([blob], m.fileName || "material", { type: m.mimetype || blob.type });
        if (nav.canShare({ files: [file] })) {
          await nav.share({ files: [file], title: m.titulo });
          return;
        }
      }
    } catch (e: any) {
      if (e?.name === "AbortError") return;
    }
    window.open(comDownload(m.url), "_blank");
  }

  const formulario = (comArquivo: boolean) => (
    <div className="space-y-3">
      {comArquivo && (
        <div>
          <Label className="text-sm">Arquivo (imagem ou PDF, até 15 MB)</Label>
          <Input type="file" accept="image/*,application/pdf" data-testid="mkt-vendas-arquivo"
            onChange={(e) => {
              const f = e.target.files?.[0] || null;
              setFArquivo(f);
              if (f && !fTitulo) setFTitulo(f.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "));
            }} />
        </div>
      )}
      <div>
        <Label className="text-sm">Título</Label>
        <Input value={fTitulo} onChange={(e) => setFTitulo(e.target.value)} placeholder="Tabela PJ — Goiânia" data-testid="mkt-vendas-titulo" />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <Label className="text-sm">Pasta</Label>
          <select className="w-full border rounded-md h-9 px-2 bg-background text-sm" value={fCategoria}
            onChange={(e) => setFCategoria(e.target.value)} data-testid="mkt-vendas-categoria">
            {CATEGORIAS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </div>
        <div>
          <Label className="text-sm">Ordem</Label>
          <Input type="number" value={fOrdem} onChange={(e) => setFOrdem(e.target.value)} />
        </div>
      </div>
      <div>
        <Label className="text-sm">Para que serve (opcional)</Label>
        <Input value={fDescricao} onChange={(e) => setFDescricao(e.target.value)} placeholder="Revenda PJ de Goiânia e entorno · pedido mínimo R$ 200" data-testid="mkt-vendas-descricao" />
      </div>
    </div>
  );

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-bold flex items-center gap-2">
            <i className="fas fa-bullhorn text-blue-600" /> Marketing de Vendas
          </h1>
          <p className="text-sm text-muted-foreground">
            Tabelas de preços, portfólio e posts oficiais. Use sempre a versão daqui para mandar ao cliente.
          </p>
        </div>
        {podeGerir && (
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch checked={mostrarInativos} onCheckedChange={setMostrarInativos} /> mostrar fora do ar
            </label>
            <Button onClick={abrirNovo} data-testid="mkt-vendas-novo">
              <i className="fas fa-upload mr-2" /> Publicar material
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={filtro === "todos" ? "default" : "outline"} onClick={() => setFiltro("todos")}>
          Tudo <Badge variant="secondary" className="ml-2">{materiais.length}</Badge>
        </Button>
        {CATEGORIAS.filter((c) => contagem[c.id]).map((c) => (
          <Button key={c.id} size="sm" variant={filtro === c.id ? "default" : "outline"} onClick={() => setFiltro(c.id)}>
            <i className={`${c.icon} mr-2`} />{c.label} <Badge variant="secondary" className="ml-2">{contagem[c.id]}</Badge>
          </Button>
        ))}
      </div>

      {q.isLoading && <p className="text-sm text-muted-foreground">Carregando material...</p>}
      {!q.isLoading && materiais.length === 0 && (
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">
          Nenhum material publicado ainda.{podeGerir ? " Use “Publicar material” para subir a primeira tabela." : " Fale com o gestor comercial."}
        </CardContent></Card>
      )}

      {grupos.map((g) => (
        <section key={g.id} className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
            <i className={g.icon} /> {g.label}
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {g.itens.map((m) => (
              <Card key={m.id} className={`overflow-hidden flex flex-col ${m.ativo ? "" : "opacity-60 border-dashed"}`} data-testid={`mkt-vendas-card-${m.id}`}>
                <button type="button" className="block bg-muted aspect-[4/5] overflow-hidden" onClick={() => setAberto(m)} title="Ver em tela cheia">
                  {ehImagem(m) ? (
                    <img src={m.url} alt={m.titulo} loading="lazy" className="w-full h-full object-cover object-top" />
                  ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center text-muted-foreground">
                      <i className="fas fa-file-pdf text-4xl mb-2" /><span className="text-xs">PDF</span>
                    </div>
                  )}
                </button>
                <CardContent className="p-3 flex-1 flex flex-col gap-2">
                  <div>
                    <div className="font-semibold text-sm leading-tight">{m.titulo}</div>
                    {m.descricao && <div className="text-xs text-muted-foreground mt-1">{m.descricao}</div>}
                    <div className="text-[11px] text-muted-foreground mt-1">
                      Atualizado em {dataBR(m.updatedAt || m.createdAt)} · {tamanho(m.fileSize)}
                      {!m.ativo && <Badge variant="outline" className="ml-1 text-[10px]">fora do ar</Badge>}
                    </div>
                  </div>
                  <div className="mt-auto grid grid-cols-2 gap-2">
                    <Button size="sm" variant="outline" onClick={() => compartilhar(m)} title="Enviar para o cliente">
                      <i className="fab fa-whatsapp mr-1" /> Enviar
                    </Button>
                    <Button size="sm" variant="outline" asChild>
                      <a href={comDownload(m.url)} download={m.fileName}><i className="fas fa-download mr-1" /> Baixar</a>
                    </Button>
                  </div>
                  {podeGerir && (
                    <div className="flex flex-wrap gap-1 pt-1 border-t">
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => abrirEdicao(m)}>Editar</Button>
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs"
                        onClick={() => { setTrocandoId(m.id); trocarRef.current?.click(); }}>Nova versão</Button>
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => alternarAtivo(m)}>
                        {m.ativo ? "Tirar do ar" : "Republicar"}
                      </Button>
                      {ehAdmin && (
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-red-600" onClick={() => excluir(m)}>Excluir</Button>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      ))}

      <input ref={trocarRef} type="file" accept="image/*,application/pdf" className="hidden"
        onChange={(e) => { trocarArquivo(e.target.files?.[0]); e.target.value = ""; }} />

      {/* visualizador */}
      <Dialog open={!!aberto} onOpenChange={(o) => !o && setAberto(null)}>
        <DialogContent className="max-w-4xl w-[95vw] p-3">
          <DialogHeader><DialogTitle className="text-base">{aberto?.titulo}</DialogTitle></DialogHeader>
          {aberto && (ehImagem(aberto) ? (
            <img src={aberto.url} alt={aberto.titulo} className="w-full max-h-[78vh] object-contain" />
          ) : (
            <iframe src={aberto.url} title={aberto.titulo} className="w-full h-[78vh] border rounded" />
          ))}
          {aberto && (
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => compartilhar(aberto)}><i className="fab fa-whatsapp mr-2" />Enviar</Button>
              <Button asChild><a href={comDownload(aberto.url)} download={aberto.fileName}><i className="fas fa-download mr-2" />Baixar</a></Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* publicar */}
      <Dialog open={novo} onOpenChange={setNovo}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Publicar material</DialogTitle></DialogHeader>
          {formulario(true)}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setNovo(false)}>Cancelar</Button>
            <Button onClick={publicar} disabled={salvando} data-testid="mkt-vendas-publicar">
              {salvando ? "Publicando..." : "Publicar para a equipe"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* editar */}
      <Dialog open={!!editando} onOpenChange={(o) => !o && setEditando(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Editar material</DialogTitle></DialogHeader>
          {formulario(false)}
          <p className="text-[11px] text-muted-foreground">Para trocar a imagem, use “Nova versão” no card.</p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setEditando(null)}>Cancelar</Button>
            <Button onClick={salvarEdicao} disabled={salvando}>{salvando ? "Salvando..." : "Salvar"}</Button>
          </div>
        </DialogContent>
      </Dialog>

    </div>
  );
}
