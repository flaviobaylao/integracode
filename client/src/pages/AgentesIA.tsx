import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";

type Agente = {
  id: string;
  nome: string;
  modelo: string;
  system_prompt?: string;
  ferramentas: string[];
  limites: Record<string, any>;
  ativo: boolean;
};

const MODELOS = ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-8"];

async function apiGet(url: string) {
  const r = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!r.ok) throw new Error("Erro ao carregar (" + r.status + ")");
  return r.json();
}

async function apiSend(url: string, method: string, body: any) {
  const r = await fetch(url, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || "Erro ao salvar (" + r.status + ")");
  return j;
}

function AgenteEditor({
  inicial,
  novo,
  onSaved,
}: {
  inicial: Agente;
  novo?: boolean;
  onSaved: () => void;
}) {
  const [a, setA] = useState<Agente>(inicial);
  const [ferramentasTxt, setFerramentasTxt] = useState((inicial.ferramentas || []).join("\n"));
  const [limitesTxt, setLimitesTxt] = useState(JSON.stringify(inicial.limites || {}, null, 2));
  const [status, setStatus] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [efetivo, setEfetivo] = useState<string>("");

  useEffect(() => {
    setA(inicial);
    setFerramentasTxt((inicial.ferramentas || []).join("\n"));
    setLimitesTxt(JSON.stringify(inicial.limites || {}, null, 2));
  }, [inicial.id]);

  const salvar = async () => {
    setStatus("");
    let limites: any = {};
    try {
      limites = limitesTxt.trim() ? JSON.parse(limitesTxt) : {};
    } catch (e) {
      setStatus("erro: limites não é um JSON válido");
      return;
    }
    const ferramentas = ferramentasTxt
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!a.id || !a.nome || !a.modelo || !a.system_prompt) {
      setStatus("erro: id, nome, modelo e prompt são obrigatórios");
      return;
    }
    setSaving(true);
    try {
      await apiSend("/api/admin/agentes/upsert", "POST", {
        id: a.id,
        nome: a.nome,
        modelo: a.modelo,
        system_prompt: a.system_prompt,
        ferramentas,
        limites,
        ativo: a.ativo,
      });
      setStatus("✓ salvo");
      onSaved();
    } catch (e: any) {
      setStatus("erro: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  const verEfetivo = async () => {
    try {
      const r = await apiGet("/api/admin/agentes/" + encodeURIComponent(a.id));
      setEfetivo(r.system_prompt_efetivo || "");
    } catch (e: any) {
      setStatus("erro: " + e.message);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 flex-wrap">
          {novo ? (
            <Input
              className="max-w-[180px]"
              placeholder="id (ex: pos_venda)"
              value={a.id}
              onChange={(e) => setA({ ...a, id: e.target.value })}
            />
          ) : (
            <Badge variant="secondary">{a.id}</Badge>
          )}
          <Input
            className="max-w-[260px]"
            placeholder="Nome do agente"
            value={a.nome}
            onChange={(e) => setA({ ...a, nome: e.target.value })}
          />
          <div className="ml-auto flex items-center gap-2">
            <Label htmlFor={"ativo-" + a.id} className="text-sm">
              Ativo
            </Label>
            <Switch
              id={"ativo-" + a.id}
              checked={a.ativo}
              onCheckedChange={(v) => setA({ ...a, ativo: v })}
            />
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label className="text-sm">Modelo</Label>
            <select
              className="w-full border rounded-md h-9 px-2 bg-background text-sm"
              value={a.modelo}
              onChange={(e) => setA({ ...a, modelo: e.target.value })}
            >
              {MODELOS.concat(MODELOS.includes(a.modelo) ? [] : [a.modelo]).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label className="text-sm">Limites (JSON)</Label>
            <Textarea
              className="font-mono text-xs"
              rows={4}
              value={limitesTxt}
              onChange={(e) => setLimitesTxt(e.target.value)}
            />
          </div>
        </div>

        <div>
          <Label className="text-sm">Ferramentas (uma por linha)</Label>
          <Textarea
            className="font-mono text-xs"
            rows={6}
            value={ferramentasTxt}
            onChange={(e) => setFerramentasTxt(e.target.value)}
          />
        </div>

        <div>
          <Label className="text-sm">System prompt (bloco do agente)</Label>
          <Textarea
            rows={14}
            value={a.system_prompt || ""}
            onChange={(e) => setA({ ...a, system_prompt: e.target.value })}
          />
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <Button onClick={salvar} disabled={saving}>
            {saving ? "Salvando..." : novo ? "Criar agente" : "Salvar"}
          </Button>
          {!novo && (
            <Button variant="outline" onClick={verEfetivo}>
              Ver prompt efetivo
            </Button>
          )}
          {status && (
            <span
              className={
                "text-sm " + (status.startsWith("erro") ? "text-red-600" : "text-green-600")
              }
            >
              {status}
            </span>
          )}
        </div>

        {efetivo && (
          <div>
            <Label className="text-sm">Prompt efetivo (BASE_COMUM + bloco) — o que o agente recebe</Label>
            <Textarea readOnly rows={16} className="font-mono text-xs" value={efetivo} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RuntimeControl() {
  const [mode, setMode] = useState<string>("");
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [testNumbers, setTestNumbers] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const load = async () => {
    try { const j = await apiGet("/api/admin/agente-runtime"); setMode(j.mode); setHasKey(!!j.hasAnthropicKey); setTestNumbers(j.testNumbers || ""); }
    catch (e: any) { setMsg("erro: " + e.message); }
  };
  useEffect(() => { load(); }, []);
  const setRuntimeMode = async (m: string) => {
    setBusy(true); setMsg("");
    try { await apiSend("/api/admin/agente-runtime", "POST", { mode: m }); setMode(m); setMsg("Modo alterado para: " + m.toUpperCase()); }
    catch (e: any) { setMsg("erro: " + e.message); }
    finally { setBusy(false); }
  };
  const label = mode === "on" ? "LIGADO (todos os clientes)" : mode === "test" ? "MODO TESTE (só nº de teste)" : "DESLIGADO";
  const color = mode === "on" ? "text-green-600" : mode === "test" ? "text-amber-600" : "text-gray-500";
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <i className="fas fa-power-off text-muted-foreground" /> Auto-resposta dos Agentes
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-sm">Status atual: <b className={color}>{label}</b></div>
        {hasKey === false && (
          <div className="text-sm text-red-600">
            ⚠️ ANTHROPIC_API_KEY não configurada — os agentes não respondem até adicionar a chave no Railway e dar deploy.
          </div>
        )}
        {!!testNumbers && <div className="text-xs text-muted-foreground">Número(s) de teste: {testNumbers}</div>}
        <div className="flex flex-wrap gap-2">
          <Button variant={mode === "off" ? "default" : "outline"} disabled={busy} onClick={() => setRuntimeMode("off")}>
            Desligar
          </Button>
          <Button variant={mode === "test" ? "default" : "outline"} disabled={busy} onClick={() => setRuntimeMode("test")}>
            Modo Teste
          </Button>
          <Button
            variant={mode === "on" ? "default" : "outline"}
            disabled={busy}
            className={mode === "on" ? "" : "bg-green-600 hover:bg-green-700 text-white"}
            onClick={() => { if (confirm("Ligar a auto-resposta para TODOS os clientes? Os agentes responderão automaticamente no WhatsApp.")) setRuntimeMode("on"); }}
          >
            Ligar p/ todos
          </Button>
          <Button variant="ghost" disabled={busy} onClick={load}>Atualizar</Button>
        </div>
        {msg && <div className={"text-sm " + (msg.startsWith("erro") ? "text-red-600" : "text-green-600")}>{msg}</div>}
        <p className="text-xs text-muted-foreground">
          OFF = não responde ninguém. TESTE = responde só o número de teste (validação no WhatsApp). LIGADO = responde todos os clientes.
        </p>
      </CardContent>
    </Card>
  );
}

export default function AgentesIA() {
  const { data, isLoading, refetch } = useQuery<{ baseComum: string | null; agentes: Agente[] }>({
    queryKey: ["/api/admin/agentes"],
    queryFn: () => apiGet("/api/admin/agentes"),
  });

  const [baseComum, setBaseComum] = useState("");
  const [baseStatus, setBaseStatus] = useState("");
  const [savingBase, setSavingBase] = useState(false);
  const [mostrarNovo, setMostrarNovo] = useState(false);

  useEffect(() => {
    if (data?.baseComum != null) setBaseComum(data.baseComum);
  }, [data?.baseComum]);

  const salvarBase = async () => {
    setBaseStatus("");
    if (!baseComum.trim()) {
      setBaseStatus("erro: base não pode ficar vazia");
      return;
    }
    setSavingBase(true);
    try {
      await apiSend("/api/admin/config/base-comum", "PUT", { valor: baseComum });
      setBaseStatus("✓ salvo");
      refetch();
    } catch (e: any) {
      setBaseStatus("erro: " + e.message);
    } finally {
      setSavingBase(false);
    }
  };

  const agentes = data?.agentes || [];

  return (
    <div className="p-6 space-y-6">
      <BackToDashboardButton />
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <i className="fas fa-robot text-primary" /> Agentes de IA
        </h1>
        <p className="text-muted-foreground text-sm">
          Configure o comportamento dos agentes de atendimento do WhatsApp. O prompt que cada agente
          recebe é a BASE_COMUM + o bloco do agente. Edição salva direto no banco (sem deploy).
        </p>
      </div>

      <RuntimeControl />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <i className="fas fa-layer-group text-muted-foreground" /> Base Comum (compartilhada por todos)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Regras gerais (tom, veracidade, privacidade, escalonamento, dados da empresa). Vale para
            todos os agentes. Preencha aqui os [placeholders] de área de entrega, horários e política de troca.
          </p>
          <Textarea
            rows={16}
            value={baseComum}
            onChange={(e) => setBaseComum(e.target.value)}
          />
          <div className="flex items-center gap-3">
            <Button onClick={salvarBase} disabled={savingBase}>
              {savingBase ? "Salvando..." : "Salvar Base Comum"}
            </Button>
            {baseStatus && (
              <span
                className={
                  "text-sm " + (baseStatus.startsWith("erro") ? "text-red-600" : "text-green-600")
                }
              >
                {baseStatus}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">
          Agentes {isLoading ? "" : "(" + agentes.length + ")"}
        </h2>
        <Button variant="outline" onClick={() => setMostrarNovo((v) => !v)}>
          <i className="fas fa-plus mr-2" /> {mostrarNovo ? "Cancelar" : "Novo agente"}
        </Button>
      </div>

      {mostrarNovo && (
        <AgenteEditor
          novo
          inicial={{ id: "", nome: "", modelo: "claude-sonnet-4-6", system_prompt: "", ferramentas: [], limites: {}, ativo: true }}
          onSaved={() => {
            setMostrarNovo(false);
            refetch();
          }}
        />
      )}

      {isLoading ? (
        <p className="text-muted-foreground">Carregando...</p>
      ) : (
        <div className="space-y-6">
          {agentes.map((ag) => (
            <AgenteEditor key={ag.id} inicial={ag} onSaved={() => refetch()} />
          ))}
        </div>
      )}
    </div>
  );
}
