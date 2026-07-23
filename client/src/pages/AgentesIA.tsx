import { useState, useEffect, useRef } from "react";
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
  base_conhecimento?: string;
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
        base_conhecimento: a.base_conhecimento || "",
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
          <Label className="text-sm">Base de Conhecimento (fatos da Honest — produtos, sabores, preços de referência, região/entrega, como virar revenda, FAQs)</Label>
          <Textarea
            rows={14}
            placeholder="Ex.: A Honest é uma fábrica de sucos em Goiânia-GO. Sabores: ... Onde comprar: ... Entrega: atendemos ... Revenda: pedido mínimo ... FAQ: ..."
            value={a.base_conhecimento || ""}
            onChange={(e) => setA({ ...a, base_conhecimento: e.target.value })}
          />
          <p className="text-xs text-muted-foreground mt-1">
            O agente responde <b>só</b> com o que estiver aqui + na Base Comum. Se faltar, ele oferece transferir para uma pessoa. Salva no banco (sem deploy).
          </p>
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

function RuntimeControl({ agentes }: { agentes: Agente[] }) {
  const [mode, setMode] = useState<string>("");
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [testNumbers, setTestNumbers] = useState<string>("");
  const [numbersTxt, setNumbersTxt] = useState<string>("");
  const [defaultAgent, setDefaultAgent] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [savingCfg, setSavingCfg] = useState(false);
  const [msg, setMsg] = useState("");
  const [cfgMsg, setCfgMsg] = useState("");

  // testador de resposta (não envia WhatsApp)
  const [testAgent, setTestAgent] = useState<string>("");
  const [testMsgInput, setTestMsgInput] = useState<string>("");
  const [testPhone, setTestPhone] = useState<string>("");
  const [withTools, setWithTools] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testReply, setTestReply] = useState<string>("");
  const [testTools, setTestTools] = useState<string>("");

  const splitNums = (s: string) =>
    (s || "").split(/[,\n;\s]+/).map((x) => x.trim()).filter(Boolean);

  const load = async () => {
    try {
      const j = await apiGet("/api/admin/agente-runtime");
      setMode(j.mode);
      setHasKey(!!j.hasAnthropicKey);
      setTestNumbers(j.testNumbers || "");
      setNumbersTxt(splitNums(j.testNumbers || "").join("\n"));
      setDefaultAgent(j.defaultAgent || "");
    } catch (e: any) {
      setMsg("erro: " + e.message);
    }
  };
  useEffect(() => {
    load();
  }, []);

  const setRuntimeMode = async (m: string) => {
    setBusy(true);
    setMsg("");
    try {
      await apiSend("/api/admin/agente-runtime", "POST", { mode: m });
      setMode(m);
      setMsg("Modo alterado para: " + m.toUpperCase());
    } catch (e: any) {
      setMsg("erro: " + e.message);
    } finally {
      setBusy(false);
    }
  };

  const salvarConfig = async () => {
    setSavingCfg(true);
    setCfgMsg("");
    const nums = splitNums(numbersTxt).join(",");
    try {
      await apiSend("/api/admin/agente-runtime", "POST", {
        testNumbers: nums,
        defaultAgent,
      });
      setTestNumbers(nums);
      setNumbersTxt(splitNums(nums).join("\n"));
      setCfgMsg("✓ salvo");
    } catch (e: any) {
      setCfgMsg("erro: " + e.message);
    } finally {
      setSavingCfg(false);
    }
  };

  const rodarTeste = async () => {
    if (!testMsgInput.trim()) {
      setTestReply("erro: digite uma mensagem para testar");
      return;
    }
    setTesting(true);
    setTestReply("");
    setTestTools("");
    try {
      const j = await apiSend("/api/admin/agente-test", "POST", {
        agentId: testAgent || defaultAgent || "sdr",
        message: testMsgInput,
        withTools,
        phone: testPhone || undefined,
      });
      setTestReply(j.reply || j.text || j.response || j.message || JSON.stringify(j));
      const tools = j.usedTools || j.tools || [];
      if (Array.isArray(tools) && tools.length) setTestTools(tools.join(", "));
    } catch (e: any) {
      setTestReply("erro: " + e.message);
    } finally {
      setTesting(false);
    }
  };

  const label =
    mode === "on"
      ? "LIGADO (todos os clientes)"
      : mode === "test"
        ? "MODO TESTE (só nº de teste)"
        : "DESLIGADO";
  const color =
    mode === "on" ? "text-green-600" : mode === "test" ? "text-amber-600" : "text-gray-500";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <i className="fas fa-power-off text-muted-foreground" /> Auto-resposta dos Agentes
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="text-sm">
          Status atual: <b className={color}>{label}</b>
        </div>
        {hasKey === false && (
          <div className="text-sm text-red-600">
            ⚠️ ANTHROPIC_API_KEY não configurada — os agentes não respondem até adicionar a chave no
            Railway e dar deploy.
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant={mode === "off" ? "default" : "outline"}
            disabled={busy}
            onClick={() => setRuntimeMode("off")}
          >
            Desligar
          </Button>
          <Button
            variant={mode === "test" ? "default" : "outline"}
            disabled={busy}
            className={mode === "test" ? "" : "bg-amber-500 hover:bg-amber-600 text-white"}
            onClick={() => setRuntimeMode("test")}
          >
            Modo Teste
          </Button>
          <Button
            variant={mode === "on" ? "default" : "outline"}
            disabled={busy}
            className={mode === "on" ? "" : "bg-green-600 hover:bg-green-700 text-white"}
            onClick={() => {
              if (
                confirm(
                  "Ligar a auto-resposta para TODOS os clientes? Os agentes responderão automaticamente no WhatsApp.",
                )
              )
                setRuntimeMode("on");
            }}
          >
            Ligar p/ todos
          </Button>
          <Button variant="ghost" disabled={busy} onClick={load}>
            Atualizar
          </Button>
        </div>
        {msg && (
          <div className={"text-sm " + (msg.startsWith("erro") ? "text-red-600" : "text-green-600")}>
            {msg}
          </div>
        )}

        <div className="border-t pt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label className="text-sm">Números de teste (um por linha)</Label>
            <Textarea
              className="font-mono text-xs"
              rows={5}
              placeholder="5562995782812"
              value={numbersTxt}
              onChange={(e) => setNumbersTxt(e.target.value)}
            />
            <p className="text-xs text-muted-foreground mt-1">
              No MODO TESTE, os agentes respondem apenas a estes números. Formato: 55 + DDD + número
              (ex.: 5562995782812).
            </p>
          </div>
          <div>
            <Label className="text-sm">Agente padrão</Label>
            <select
              className="w-full border rounded-md h-9 px-2 bg-background text-sm"
              value={defaultAgent}
              onChange={(e) => setDefaultAgent(e.target.value)}
            >
              {agentes.length === 0 && <option value={defaultAgent}>{defaultAgent || "—"}</option>}
              {agentes.map((ag) => (
                <option key={ag.id} value={ag.id}>
                  {ag.id} — {ag.nome}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground mt-1">
              Usado quando o roteamento por palavra-chave não identifica um agente específico.
            </p>
            <div className="mt-3 flex items-center gap-3">
              <Button onClick={salvarConfig} disabled={savingCfg}>
                {savingCfg ? "Salvando..." : "Salvar números e agente padrão"}
              </Button>
              {cfgMsg && (
                <span
                  className={
                    "text-sm " + (cfgMsg.startsWith("erro") ? "text-red-600" : "text-green-600")
                  }
                >
                  {cfgMsg}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="border-t pt-4 space-y-3">
          <Label className="text-sm font-semibold">
            Testar resposta de um agente (não envia WhatsApp)
          </Label>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <Label className="text-xs">Agente</Label>
              <select
                className="w-full border rounded-md h-9 px-2 bg-background text-sm"
                value={testAgent}
                onChange={(e) => setTestAgent(e.target.value)}
              >
                <option value="">(roteamento automático)</option>
                {agentes.map((ag) => (
                  <option key={ag.id} value={ag.id}>
                    {ag.id} — {ag.nome}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-xs">Telefone (opcional, p/ ferramentas)</Label>
              <Input
                placeholder="5562995782812"
                value={testPhone}
                onChange={(e) => setTestPhone(e.target.value)}
              />
            </div>
            <div className="flex items-end gap-2">
              <div className="flex items-center gap-2">
                <Switch id="withTools" checked={withTools} onCheckedChange={setWithTools} />
                <Label htmlFor="withTools" className="text-xs">
                  Usar ferramentas
                </Label>
              </div>
            </div>
          </div>
          <div>
            <Label className="text-xs">Mensagem do cliente</Label>
            <Textarea
              rows={2}
              placeholder="oi, quero comprar sucos"
              value={testMsgInput}
              onChange={(e) => setTestMsgInput(e.target.value)}
            />
          </div>
          <Button onClick={rodarTeste} disabled={testing} variant="outline">
            {testing ? "Testando..." : "Testar resposta"}
          </Button>
          {testReply && (
            <div>
              <Label className="text-xs">
                Resposta do agente{testTools ? " — ferramentas: " + testTools : ""}
              </Label>
              <Textarea
                readOnly
                rows={6}
                className={"text-sm " + (testReply.startsWith("erro") ? "text-red-600" : "")}
                value={testReply}
              />
            </div>
          )}
        </div>

        <p className="text-xs text-muted-foreground border-t pt-3">
          OFF = não responde ninguém. TESTE = responde só os números de teste (validação no
          WhatsApp). LIGADO = responde todos os clientes.
        </p>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Gestão de Notificações (Automações de Comunicação) — CRUD + testar + modo global.
// ============================================================================
function recipientFlags(rt: string) {
  const s = String(rt || "");
  return { toSeller: s.includes("vendedor_pedido"), toFixed: s.includes("fixo"), toUser: s.includes("usuario") };
}
function recipientLabel(a: any, users: any[]) {
  const f = recipientFlags(a.recipient_type);
  const parts: string[] = [];
  if (f.toSeller) parts.push("Vendedor do pedido");
  if (f.toFixed) parts.push("Fixo: " + (a.recipient_fixed_phone || "—"));
  if (f.toUser) { const u = users.find((x) => x.id === a.recipient_user_id); parts.push("Usuário: " + (u?.name || a.recipient_user_id || "—")); }
  return parts.join(" · ") || "—";
}

function NotificacoesManager() {
  const [list, setList] = useState<any[]>([]);
  const [meta, setMeta] = useState<any>({ mode: "off", testNumber: "", triggers: [], placeholders: [], users: [] });
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [edit, setEdit] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [a, m] = await Promise.all([apiGet("/api/admin/automations"), apiGet("/api/admin/automations/meta")]);
      setList(a.automations || []);
      setMeta(m);
    } catch (e: any) { setMsg("Erro: " + e.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const blank = () => ({ id: "", name: "", description: "", trigger_event: "pedido.criado", message_template: "", is_active: true, toSeller: true, toFixed: false, toUser: false, recipient_fixed_phone: "", recipient_user_id: "" });
  const startEdit = (a: any) => setEdit({ ...a, ...recipientFlags(a.recipient_type), recipient_fixed_phone: a.recipient_fixed_phone || "", recipient_user_id: a.recipient_user_id || "" });

  const insertPlaceholder = (tok: string) => {
    setEdit((e: any) => {
      if (!e) return e;
      const ta = taRef.current;
      const cur = e.message_template || "";
      if (ta && typeof ta.selectionStart === "number") {
        const s = ta.selectionStart, en = ta.selectionEnd;
        return { ...e, message_template: cur.slice(0, s) + tok + cur.slice(en) };
      }
      return { ...e, message_template: cur + tok };
    });
  };

  const save = async () => {
    if (!edit) return;
    if (!String(edit.name || "").trim()) { setMsg("Erro: informe um nome"); return; }
    if (!String(edit.message_template || "").trim()) { setMsg("Erro: escreva a mensagem"); return; }
    setBusy(true); setMsg("");
    try {
      const body: any = {
        name: edit.name, description: edit.description, trigger_event: edit.trigger_event,
        message_template: edit.message_template, is_active: edit.is_active,
        toSeller: !!edit.toSeller, toFixed: !!edit.toFixed, toUser: !!edit.toUser,
        recipient_fixed_phone: edit.recipient_fixed_phone, recipient_user_id: edit.recipient_user_id,
      };
      if (edit.id) await apiSend("/api/admin/automations/" + edit.id, "PATCH", body);
      else await apiSend("/api/admin/automations", "POST", body);
      setEdit(null); setMsg("✓ salvo"); await load();
    } catch (e: any) { setMsg("Erro: " + e.message); }
    finally { setBusy(false); }
  };

  const toggleActive = async (a: any) => {
    try { await apiSend("/api/admin/automations/" + a.id, "PATCH", { is_active: !a.is_active }); await load(); }
    catch (e: any) { setMsg("Erro: " + e.message); }
  };
  const remove = async (a: any) => {
    if (!window.confirm(`Excluir a automação "${a.name}"? Esta ação não pode ser desfeita.`)) return;
    try { await apiSend("/api/admin/automations/" + a.id, "DELETE", {}); setMsg("✓ excluída"); await load(); }
    catch (e: any) { setMsg("Erro: " + e.message); }
  };
  const test = async (a: any) => {
    setMsg("Enviando teste...");
    try { const r = await apiSend("/api/admin/automations/" + a.id + "/test", "POST", {}); setMsg(r.ok ? `✓ teste enviado para ${r.to}` : `Falha no teste: ${r.error || "?"}`); }
    catch (e: any) { setMsg("Erro: " + e.message); }
  };
  const setMode = async (mode: string) => {
    if (mode === "on" && !window.confirm("Ligar o modo ON faz TODAS as automações ativas enviarem WhatsApp de verdade. Confirmar?")) return;
    try { const r = await apiSend("/api/admin/automations/mode", "POST", { mode }); setMeta((m: any) => ({ ...m, mode: r.mode })); setMsg("✓ modo: " + r.mode); }
    catch (e: any) { setMsg("Erro: " + e.message); }
  };
  const saveTestNumber = async () => {
    try { const r = await apiSend("/api/admin/automations/mode", "POST", { testNumber: meta.testNumber }); setMeta((m: any) => ({ ...m, testNumber: r.testNumber })); setMsg("✓ número de teste salvo"); }
    catch (e: any) { setMsg("Erro: " + e.message); }
  };

  const modeColor = (m: string) => m === "on" ? "bg-green-600" : m === "test" ? "bg-amber-500" : "bg-gray-400";

  return (
    <div className="space-y-4">
      {/* Modo global */}
      <Card>
        <CardContent className="pt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">Modo global:</span>
            <Badge className={modeColor(meta.mode) + " text-white"}>{(meta.mode || "off").toUpperCase()}</Badge>
            <div className="flex gap-1">
              {["off", "test", "on"].map((m) => (
                <Button key={m} size="sm" variant={meta.mode === m ? "default" : "outline"} onClick={() => setMode(m)}>{m.toUpperCase()}</Button>
              ))}
            </div>
            <span className="text-xs text-muted-foreground">OFF = não envia · TEST = só p/ número de teste · ON = envia de verdade</span>
          </div>
          <div className="flex items-center gap-2">
            <Label className="text-sm">Número de teste:</Label>
            <Input className="max-w-[220px]" value={meta.testNumber || ""} onChange={(e) => setMeta((m: any) => ({ ...m, testNumber: e.target.value }))} placeholder="5562999999999" />
            <Button size="sm" variant="outline" onClick={saveTestNumber}>Salvar número</Button>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold">Automações {loading ? "" : "(" + list.length + ")"}</h3>
        <Button size="sm" variant="outline" onClick={() => setEdit(blank())}><i className="fas fa-plus mr-2" /> Nova notificação</Button>
      </div>
      {msg && <div className={"text-sm " + (msg.startsWith("Erro") || msg.startsWith("Falha") ? "text-red-600" : "text-green-600")}>{msg}</div>}

      {/* Editor */}
      {edit && (
        <Card className="border-primary">
          <CardHeader><CardTitle className="text-base">{edit.id ? "Editar notificação" : "Nova notificação"}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <Label>Nome</Label>
                <Input value={edit.name} onChange={(e) => setEdit((x: any) => ({ ...x, name: e.target.value }))} />
              </div>
              <div>
                <Label>Gatilho</Label>
                <select className="w-full border rounded px-2 py-2 text-sm bg-background" value={edit.trigger_event} onChange={(e) => setEdit((x: any) => ({ ...x, trigger_event: e.target.value }))}>
                  {(meta.triggers || []).map((t: any) => (<option key={t.event} value={t.event}>{t.event}{t.fired ? "" : " (não disparado)"}</option>))}
                  {!(meta.triggers || []).some((t: any) => t.event === edit.trigger_event) && edit.trigger_event && (<option value={edit.trigger_event}>{edit.trigger_event}</option>)}
                </select>
                <p className="text-[11px] text-muted-foreground mt-1">{((meta.triggers || []).find((t: any) => t.event === edit.trigger_event) || {}).label || ""}</p>
              </div>
            </div>
            <div>
              <Label>Descrição (opcional)</Label>
              <Input value={edit.description || ""} onChange={(e) => setEdit((x: any) => ({ ...x, description: e.target.value }))} />
            </div>
            <div>
              <Label>Mensagem</Label>
              <Textarea ref={taRef} rows={5} value={edit.message_template} onChange={(e) => setEdit((x: any) => ({ ...x, message_template: e.target.value }))} className="font-mono text-xs" />
              <div className="flex flex-wrap gap-1 mt-1">
                {(meta.placeholders || []).map((p: any) => (
                  <button key={p.token} type="button" title={p.desc} onClick={() => insertPlaceholder(p.token)} className="text-[11px] px-2 py-0.5 rounded border border-primary/40 text-primary hover:bg-primary/10">{p.token}</button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label>Destinatários</Label>
              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!edit.toSeller} onChange={(e) => setEdit((x: any) => ({ ...x, toSeller: e.target.checked }))} /> Vendedor do pedido</label>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!edit.toFixed} onChange={(e) => setEdit((x: any) => ({ ...x, toFixed: e.target.checked }))} /> Número fixo</label>
                {edit.toFixed && (<Input className="max-w-[200px]" placeholder="55629..." value={edit.recipient_fixed_phone || ""} onChange={(e) => setEdit((x: any) => ({ ...x, recipient_fixed_phone: e.target.value }))} />)}
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!edit.toUser} onChange={(e) => setEdit((x: any) => ({ ...x, toUser: e.target.checked }))} /> Usuário</label>
                {edit.toUser && (
                  <select className="border rounded px-2 py-1 text-sm bg-background max-w-[220px]" value={edit.recipient_user_id || ""} onChange={(e) => setEdit((x: any) => ({ ...x, recipient_user_id: e.target.value }))}>
                    <option value="">— escolha —</option>
                    {(meta.users || []).map((u: any) => (<option key={u.id} value={u.id}>{u.name}{u.phone ? "" : " (sem telefone)"}</option>))}
                  </select>
                )}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm"><Switch checked={!!edit.is_active} onCheckedChange={(v) => setEdit((x: any) => ({ ...x, is_active: v }))} /> Ativa</label>
              <div className="flex-1" />
              <Button variant="outline" onClick={() => setEdit(null)}>Cancelar</Button>
              <Button onClick={save} disabled={busy}>{busy ? "Salvando..." : "Salvar"}</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Lista */}
      <div className="space-y-2">
        {list.map((a) => (
          <Card key={a.id}>
            <CardContent className="pt-4">
              <div className="flex flex-wrap items-center gap-2">
                <Switch checked={!!a.is_active} onCheckedChange={() => toggleActive(a)} />
                <span className="font-semibold">{a.name || "(sem nome)"}</span>
                <Badge variant="outline">{a.trigger_event}</Badge>
                <span className="text-xs text-muted-foreground">{recipientLabel(a, meta.users || [])}</span>
                <div className="flex-1" />
                <span className="text-[11px] text-muted-foreground">env: {a.sent_count ?? 0} · falhas: {a.failed_count ?? 0}</span>
                <Button size="sm" variant="outline" onClick={() => test(a)}>Testar</Button>
                <Button size="sm" variant="outline" onClick={() => startEdit(a)}>Editar</Button>
                <Button size="sm" variant="outline" className="text-red-600 border-red-300 hover:bg-red-50" onClick={() => remove(a)}>Excluir</Button>
              </div>
              {a.message_template && (<p className="text-xs text-muted-foreground mt-2 whitespace-pre-wrap line-clamp-2">{a.message_template}</p>)}
            </CardContent>
          </Card>
        ))}
        {!loading && list.length === 0 && (<p className="text-sm text-muted-foreground">Nenhuma automação cadastrada. Clique em "Nova notificação".</p>)}
      </div>
    </div>
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

  {/* Disparos 1841 — agora ACIMA, com mostrar/ocultar */}
      <details open>
        <summary style={{ cursor: "pointer", fontWeight: 700, fontSize: 18, padding: "10px 0" }}>
          📣 Disparos 1841 (WhatsApp API oficial) — mostrar/ocultar
        </summary>
        <Card className="mt-2">
          <CardContent>
            <iframe
              src="/api/admin/oficial/painel"
              style={{ width: "100%", height: "820px", border: 0, borderRadius: 12 }}
              title="Painel de Disparos 1841"
            />
          </CardContent>
        </Card>
      </details>

      {/* IA de Atendimento — regras da IA (Fase 1) */}
      <details open>
        <summary style={{ cursor: "pointer", fontWeight: 700, fontSize: 18, padding: "10px 0" }}>
          🤖 IA de Atendimento (regras da IA) — mostrar/ocultar
        </summary>
        <Card className="mt-2">
          <CardContent>
            <iframe
              src="/api/admin/ia-atendimento/painel"
              style={{ width: "100%", height: "760px", border: 0, borderRadius: 12 }}
              title="Painel de IA de Atendimento"
            />
          </CardContent>
        </Card>
      </details>

      {/* Notificações (Automações de Comunicação) — gestão completa */}
      <details open>
        <summary style={{ cursor: "pointer", fontWeight: 700, fontSize: 18, padding: "10px 0" }}>
          🔔 Notificações (Automações de Comunicação) — mostrar/ocultar
        </summary>
        <div className="mt-2">
          <NotificacoesManager />
        </div>
      </details>

      {/* Auto-resposta dos Agentes — agora ABAIXO, com mostrar/ocultar */}
      <details open>
        <summary style={{ cursor: "pointer", fontWeight: 700, fontSize: 18, padding: "10px 0" }}>
          🤖 Auto-resposta dos Agentes — mostrar/ocultar
        </summary>
     <div className="mt-2 space-y-6">
          <RuntimeControl agentes={agentes} />
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
      </details>
    </div>
  );
}
