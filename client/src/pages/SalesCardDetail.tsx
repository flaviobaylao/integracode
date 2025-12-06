import { useEffect, useState } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery } from "@/lib/queryClient";
import SalesCardDetailsModal from "@/components/SalesCardDetailsModal";
import type { SalesCardWithRelations } from "@shared/schema";

export default function SalesCardDetail() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const [selectedCard, setSelectedCard] = useState<SalesCardWithRelations | null>(null);

  const { data: card, isLoading } = useQuery({
    queryKey: ['/api/sales-cards', id],
    queryFn: async () => {
      const response = await fetch(`/api/sales-cards/${id}`);
      if (!response.ok) throw new Error('Failed to fetch card');
      return response.json();
    },
    enabled: !!id,
  });

  useEffect(() => {
    if (card) {
      setSelectedCard(card);
    }
  }, [card]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-600 mx-auto"></div>
          <p className="text-gray-600 mt-4">Carregando...</p>
        </div>
      </div>
    );
  }

  return (
    <SalesCardDetailsModal
      isOpen={!!selectedCard}
      onClose={() => navigate('/vendas')}
      card={selectedCard || undefined}
    />
  );
}
