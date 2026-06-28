import BackToDashboardButton from "@/components/BackToDashboardButton";
import SyncedTable from "@/components/SyncedTable";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

export default function IndustriaDados() {
  return (
    <div className="p-6">
      <BackToDashboardButton />
      <h1 className="text-2xl font-bold mb-4">Indústria — Matéria-Prima e Receitas</h1>
      <Tabs defaultValue="materia">
        <TabsList>
          <TabsTrigger value="materia">Matéria-Prima</TabsTrigger>
          <TabsTrigger value="receitas">Receitas</TabsTrigger>
          <TabsTrigger value="itens">Itens de Receita</TabsTrigger>
          <TabsTrigger value="ordens">Ordens de Produção</TabsTrigger>
        </TabsList>
        <TabsContent value="materia">
          <SyncedTable table="raw_materials" hideColumns={["id", "instance_id"]}
            labels={{ name: "Material", code: "Código", category: "Categoria", unit: "Un.", quantity: "Estoque", min_quantity: "Mínimo", unit_cost: "Custo Unit.", supplier: "Fornecedor", instance_name: "Instância", description: "Descrição", is_active: "Ativo" }} />
        </TabsContent>
        <TabsContent value="receitas">
          <SyncedTable table="recipes" hideColumns={["id", "product_id", "created_by"]}
            labels={{ name: "Receita", product_name: "Produto", type: "Tipo", estimated_yield: "Rendimento", yield_unit: "Un. Rend.", description: "Descrição", is_active: "Ativa", registration_date: "Cadastro" }} />
        </TabsContent>
        <TabsContent value="itens"><SyncedTable table="recipe_items" hideColumns={["id"]} /></TabsContent>
        <TabsContent value="ordens"><SyncedTable table="production_orders" hideColumns={["id"]} /></TabsContent>
      </Tabs>
    </div>
  );
}
