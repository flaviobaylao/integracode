import { useAuth } from "@/hooks/useAuth";
import Layout from "@/components/Layout";
import BlockedOrdersManagement from "@/components/BlockedOrdersManagement";

export default function BlockedOrdersPage() {
  const { user } = useAuth();

  return (
    <Layout>
      <BlockedOrdersManagement user={user} />
    </Layout>
  );
}
