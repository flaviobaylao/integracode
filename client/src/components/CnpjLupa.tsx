import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, Search } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cidadeCanonica } from "@/lib/cidadePadrao";

export type DadosReceita = {
  cnpj: string;
  razaoSocial: string;
  nomeFantasia: string;
  endereco: string;      // logradouro, número, complemento (sem o bairro)
  enderecoCompleto: string;
  bairro: string;
  cidade: string;
  estado: string;
  cep: string;
  telefone: string;
  email: string;
  situacao: string;
  jaCadastrado?: { nome: string; vendedor?: string | null; isActive: boolean } | null;
};

/** Formata enquanto digita: 00.000.000/0000-00 */
export function mascaraCnpj(v: string): string {
  const d = String(v || "").replace(/\D/g, "").slice(0, 14);
  if (d.length <= 2) return d;
  if (d.length <= 5) return d.replace(/(\d{2})(\d{0,3})/, "$1.$2");
  if (d.length <= 8) return d.replace(/(\d{2})(\d{3})(\d{0,3})/, "$1.$2.$3");
  if (d.length <= 12) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{0,4})/, "$1.$2.$3/$4");
  return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{0,2})/, "$1.$2.$3/$4-$5");
}

/**
 * 🔍 Lupa: consulta o CNPJ na Receita Federal (POST /api/receita/cnpj) e devolve os dados já
 * separados para preencher o formulário. Também avisa se o CNPJ já é cliente cadastrado.
 */
export default function CnpjLupa({ cnpj, onData, testId = "button-cnpj-lupa" }: {
  cnpj: string;
  onData: (d: DadosReceita) => void;
  testId?: string;
}) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const dig = String(cnpj || "").replace(/\D/g, "");

  const buscar = async (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    if (dig.length !== 14) {
      toast({ title: "CNPJ incompleto", description: "Digite os 14 números do CNPJ.", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
      let jaCadastrado: DadosReceita["jaCadastrado"] = null;
      try {
        const r = await fetch(`/api/customers/cnpj-lookup?cnpj=${dig}`, { credentials: "same-origin" });
        if (r.ok) {
          const j = await r.json();
          if (j?.exists && Array.isArray(j.matches) && j.matches.length) {
            const m = j.matches[0];
            jaCadastrado = { nome: m.nome, vendedor: m.vendedor || null, isActive: !!m.is_active || !!m.isActive };
          }
        }
      } catch { /* não bloqueia a consulta */ }

      const resp = await fetch("/api/receita/cnpj", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cnpj: dig }),
      });
      const data: any = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data?.message || "Não foi possível consultar o CNPJ.");

      const rua = [data.logradouro, data.numero, data.complemento].filter((x: any) => String(x || "").trim()).join(", ");
      const out: DadosReceita = {
        cnpj: data.cnpj || mascaraCnpj(dig),
        razaoSocial: data.razaoSocial || "",
        nomeFantasia: data.nomeFantasia || "",
        endereco: rua || data.endereco || "",
        enderecoCompleto: data.endereco || "",
        bairro: data.bairro || "",
        cidade: cidadeCanonica(data.cidade || ""),
        estado: data.estado || "",
        cep: data.cep || "",
        telefone: data.telefone || "",
        email: data.email || "",
        situacao: data.situacao || "",
        jaCadastrado,
      };
      onData(out);
      if (jaCadastrado) {
        toast({ title: "⚠️ CNPJ já cadastrado", description: `${jaCadastrado.nome}${jaCadastrado.vendedor ? ` · ${jaCadastrado.vendedor}` : ""}${jaCadastrado.isActive ? "" : " (inativo)"}. Confira antes de converter.`, variant: "destructive" });
      } else if (out.situacao && out.situacao.toUpperCase() !== "ATIVA") {
        toast({ title: `CNPJ ${out.situacao}`, description: "A empresa não está ATIVA na Receita. Confira antes de converter.", variant: "destructive" });
      } else {
        toast({ title: "Dados da Receita preenchidos", description: out.razaoSocial });
      }
    } catch (err: any) {
      toast({ title: "Erro na consulta do CNPJ", description: String(err?.message || err), variant: "destructive" });
    } finally { setLoading(false); }
  };

  return (
    <Button type="button" variant="outline" size="icon" className="shrink-0" onClick={buscar} disabled={loading || dig.length !== 14}
      title="Buscar dados na Receita Federal" aria-label="Buscar CNPJ na Receita" data-testid={testId}>
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
    </Button>
  );
}
