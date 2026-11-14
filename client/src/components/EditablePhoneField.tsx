import { useState } from "react";
import { Phone, Check, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

// 👤 nov/2026: ao editar o telefone, o RESPONSÁVEL (customers.contact) vem ao lado e é
// obrigatório — é com esse nome que a IA fala no WhatsApp para confirmar o número.
const responsavelValido = (v: string) => {
  const s = String(v || "").replace(/\s+/g, " ").trim();
  return s.length >= 2 && /[A-Za-zÀ-ÿ]/.test(s);
};

export default function EditablePhoneField({
  customerId,
  phone,
  contact,
  onUpdate
}: {
  customerId: string;
  phone: string;
  /** Responsável já conhecido (opcional — se não vier, é lido do cadastro ao abrir a edição). */
  contact?: string | null;
  onUpdate?: (newPhone: string, newContact?: string) => void
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [newPhone, setNewPhone] = useState(phone);
  const [newContact, setNewContact] = useState<string>(contact || "");
  const [shownContact, setShownContact] = useState<string>(contact || "");
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  const abrir = async () => {
    setNewPhone(phone);
    setIsEditing(true);
    if (contact == null || contact === "") {
      try {
        const c: any = await apiRequest("GET", `/api/customers/${customerId}`);
        const atual = String((c && (c.contact ?? c.customer?.contact)) || "");
        setNewContact(atual);
        setShownContact(atual);
      } catch { /* segue em branco: o vendedor preenche */ }
    } else {
      setNewContact(contact);
    }
  };

  const handleSave = async () => {
    if (!newPhone) {
      toast({ title: "Telefone não pode estar vazio", variant: "destructive" });
      return;
    }
    if (!responsavelValido(newContact)) {
      toast({ title: "Responsável obrigatório", description: "Informe o nome do responsável por este telefone.", variant: "destructive" });
      return;
    }
    const resp = newContact.replace(/\s+/g, " ").trim();
    setIsLoading(true);
    try {
      await apiRequest('PATCH', `/api/customers/${customerId}/phone`, { phone: newPhone, contact: resp });
      toast({ title: "Telefone e responsável atualizados!" });
      setIsEditing(false);
      setShownContact(resp);
      onUpdate?.(newPhone, resp);
    } catch (error: any) {
      toast({ title: "Erro ao atualizar telefone", description: error?.message, variant: "destructive" });
      setNewPhone(phone);
    } finally {
      setIsLoading(false);
    }
  };

  if (isEditing) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={newPhone}
          onChange={(e) => setNewPhone(e.target.value)}
          className="h-8 text-sm w-36"
          placeholder="Telefone"
          autoFocus
          data-testid={`input-phone-edit-${customerId}`}
        />
        <Input
          value={newContact}
          onChange={(e) => setNewContact(e.target.value)}
          className="h-8 text-sm w-44"
          placeholder="Responsável *"
          title="Nome do responsável por este telefone (obrigatório)"
          maxLength={120}
          data-testid={`input-contact-edit-${customerId}`}
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={handleSave}
          disabled={isLoading}
          className="h-8 w-8 p-0"
          data-testid={`button-phone-save-${customerId}`}
        >
          <Check className="h-4 w-4 text-green-600" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setIsEditing(false);
            setNewPhone(phone);
          }}
          disabled={isLoading}
          className="h-8 w-8 p-0"
          data-testid={`button-phone-cancel-${customerId}`}
        >
          <X className="h-4 w-4 text-red-600" />
        </Button>
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-2 cursor-pointer hover:text-blue-600 hover:underline"
      onClick={abrir}
      data-testid={`editable-phone-field-${customerId}`}
    >
      <Phone className="h-4 w-4" />
      <span>{phone || "Sem telefone"}</span>
      {(shownContact || contact) ? <span className="text-muted-foreground">· {shownContact || contact}</span> : null}
    </div>
  );
}
