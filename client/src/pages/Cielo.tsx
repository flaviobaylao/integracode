import BackToDashboardButton from "@/components/BackToDashboardButton";
import SyncedTable from "@/components/SyncedTable";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

export default function Cielo() {
  return (
    <div className="p-6">
      <BackToDashboardButton />
      <h1 className="text-2xl font-bold mb-4">Cielo (PIX / Cartão)</h1>
      <Tabs defaultValue="pix">
        <TabsList>
          <TabsTrigger value="pix">Cobranças PIX</TabsTrigger>
          <TabsTrigger value="card">Cartão</TabsTrigger>
        </TabsList>
        <TabsContent value="pix"><SyncedTable table="cielo_pix_charges" hideColumns={["id"]} /></TabsContent>
        <TabsContent value="card"><SyncedTable table="cielo_card_authorizations" hideColumns={["id"]} /></TabsContent>
      </Tabs>
    </div>
  );
}
