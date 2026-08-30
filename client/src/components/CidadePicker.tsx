import { useMemo, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { CIDADES_GO_DF } from "@/lib/cidadePadrao";

// Pick-list PADRONIZADA de cidade (Goiás + DF, nomes oficiais do IBGE com acento).
// Estrito: o usuário só escolhe da lista (com busca). Se o cadastro já tiver uma
// cidade fora da lista, ela é mostrada em destaque (âmbar) mas só muda escolhendo
// uma da lista — nada é apagado silenciosamente.
export function CidadePicker({
  value,
  onChange,
  placeholder = "Selecione a cidade",
  disabled,
  testId,
}: {
  value?: string | null;
  onChange: (city: string) => void;
  placeholder?: string;
  disabled?: boolean;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = String(value || "").trim();
  const naLista = useMemo(() => CIDADES_GO_DF.includes(current), [current]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          data-testid={testId || "city-picker"}
          className="w-full justify-between font-normal"
        >
          <span className={cn(!current && "text-muted-foreground", current && !naLista && "text-amber-600")}>
            {current || placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command>
          <CommandInput placeholder="Buscar cidade..." />
          <CommandList>
            <CommandEmpty>Nenhuma cidade encontrada.</CommandEmpty>
            <CommandGroup>
              {current && !naLista && (
                <CommandItem value={"__atual__" + current} disabled className="text-amber-600">
                  Atual (fora da lista): {current}
                </CommandItem>
              )}
              {CIDADES_GO_DF.map((cidade) => (
                <CommandItem
                  key={cidade}
                  value={cidade}
                  onSelect={() => {
                    onChange(cidade);
                    setOpen(false);
                  }}
                >
                  <Check className={cn("mr-2 h-4 w-4", current === cidade ? "opacity-100" : "opacity-0")} />
                  {cidade}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export default CidadePicker;
