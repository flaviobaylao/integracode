import { useState } from "react";
import { Phone, Check, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

export default function EditablePhoneField({ 
  customerId, 
  phone, 
  onUpdate 
}: { 
  customerId: string; 
  phone: string; 
  onUpdate?: (newPhone: string) => void 
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [newPhone, setNewPhone] = useState(phone);
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  const handleSave = async () => {
    if (!newPhone) {
      toast({ title: "Telefone não pode estar vazio", variant: "destructive" });
      return;
    }
    
    setIsLoading(true);
    try {
      await apiRequest('PATCH', `/api/customers/${customerId}/phone`, { phone: newPhone });
      toast({ title: "Telefone atualizado com sucesso!" });
      setIsEditing(false);
      onUpdate?.(newPhone);
    } catch (error) {
      toast({ title: "Erro ao atualizar telefone", variant: "destructive" });
      setNewPhone(phone);
    } finally {
      setIsLoading(false);
    }
  };

  if (isEditing) {
    return (
      <div className="flex items-center gap-2">
        <Input
          value={newPhone}
          onChange={(e) => setNewPhone(e.target.value)}
          className="h-8 text-sm"
          autoFocus
          data-testid={`input-phone-edit-${customerId}`}
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
      onClick={() => setIsEditing(true)}
      data-testid={`editable-phone-field-${customerId}`}
    >
      <Phone className="h-4 w-4" />
      <span>{phone || "Sem telefone"}</span>
    </div>
  );
}
