import type { Express } from "express";
import { authenticateUser, requireRole } from "./authMiddleware";
import { storage } from "./storage";
import axios from "axios";

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

interface GooglePlaceResult {
  place_id: string;
  name: string;
  formatted_address: string;
  formatted_phone_number?: string;
  international_phone_number?: string;
  website?: string;
  rating?: number;
  user_ratings_total?: number;
  types?: string[];
  opening_hours?: {
    open_now?: boolean;
  };
  geometry?: {
    location: {
      lat: number;
      lng: number;
    };
  };
}

export function registerSdrRoutes(app: Express) {
  // GET /api/sdr/buscar-leads - Buscar leads via Google Places
  app.get("/api/sdr/buscar-leads", authenticateUser, requireRole(['admin', 'coordinator', 'telemarketing']), async (req, res) => {
    try {
      const { regiao, categoria, palavraChave } = req.query;
      
      if (!regiao || typeof regiao !== 'string') {
        return res.status(400).json({ error: "Região é obrigatória" });
      }

      if (!GOOGLE_PLACES_API_KEY) {
        return res.status(500).json({ error: "Google Places API não configurada. Adicione GOOGLE_PLACES_API_KEY nos secrets." });
      }

      // Montar query de busca
      let query = regiao;
      if (categoria && typeof categoria === 'string') {
        const categoriaLabel = getCategoryLabel(categoria);
        query = `${categoriaLabel} em ${regiao}`;
      }
      if (palavraChave && typeof palavraChave === 'string') {
        query = `${palavraChave} ${query}`;
      }

      console.log(`🔍 [SDR] Buscando: "${query}"`);

      // Busca via Text Search
      const searchResponse = await axios.get(
        'https://maps.googleapis.com/maps/api/place/textsearch/json',
        {
          params: {
            query,
            key: GOOGLE_PLACES_API_KEY,
            language: 'pt-BR',
            region: 'br'
          }
        }
      );

      if (searchResponse.data.status !== 'OK' && searchResponse.data.status !== 'ZERO_RESULTS') {
        console.error('[SDR] Erro Google Places:', searchResponse.data);
        return res.status(500).json({ error: `Erro na API: ${searchResponse.data.status}` });
      }

      const places: GooglePlaceResult[] = searchResponse.data.results || [];
      
      // Para cada resultado, buscar detalhes (telefone, website)
      const leadsWithDetails = await Promise.all(
        places.slice(0, 20).map(async (place) => {
          try {
            const detailsResponse = await axios.get(
              'https://maps.googleapis.com/maps/api/place/details/json',
              {
                params: {
                  place_id: place.place_id,
                  fields: 'formatted_phone_number,international_phone_number,website,opening_hours',
                  key: GOOGLE_PLACES_API_KEY,
                  language: 'pt-BR'
                }
              }
            );

            const details = detailsResponse.data.result || {};
            
            return {
              placeId: place.place_id,
              name: place.name,
              address: place.formatted_address,
              phone: details.formatted_phone_number || details.international_phone_number,
              website: details.website,
              rating: place.rating,
              userRatingsTotal: place.user_ratings_total,
              types: place.types?.filter((t: string) => !['point_of_interest', 'establishment'].includes(t)),
              openNow: details.opening_hours?.open_now,
              latitude: place.geometry?.location?.lat,
              longitude: place.geometry?.location?.lng
            };
          } catch (err) {
            console.warn(`[SDR] Erro ao buscar detalhes de ${place.name}:`, err);
            return {
              placeId: place.place_id,
              name: place.name,
              address: place.formatted_address,
              rating: place.rating,
              userRatingsTotal: place.user_ratings_total,
              types: place.types?.filter((t: string) => !['point_of_interest', 'establishment'].includes(t))
            };
          }
        })
      );

      console.log(`✅ [SDR] Encontrados ${leadsWithDetails.length} leads para "${query}"`);

      res.json({ 
        success: true, 
        leads: leadsWithDetails,
        query,
        total: leadsWithDetails.length
      });
    } catch (error: any) {
      console.error("[SDR] Erro ao buscar leads:", error);
      res.status(500).json({ error: error.message || "Erro ao buscar leads" });
    }
  });

  // POST /api/sdr/enviar-apresentacao - Enviar apresentação via WhatsApp
  app.post("/api/sdr/enviar-apresentacao", authenticateUser, requireRole(['admin', 'coordinator', 'telemarketing']), async (req, res) => {
    try {
      const { phone, leadName, leadAddress } = req.body;
      
      if (!phone) {
        return res.status(400).json({ error: "Telefone é obrigatório" });
      }

      // Limpar e formatar telefone
      let cleanPhone = phone.replace(/\D/g, '');
      if (cleanPhone.startsWith('0')) {
        cleanPhone = cleanPhone.substring(1);
      }
      if (!cleanPhone.startsWith('55')) {
        cleanPhone = '55' + cleanPhone;
      }

      // Mensagem de apresentação
      const message = `Olá! 👋

Somos a *Honest Sucos*, especialistas em sucos naturais e bebidas saudáveis! 🍊🥤

Estamos entrando em contato porque acreditamos que seu estabelecimento *${leadName || 'seu negócio'}* pode se beneficiar dos nossos produtos de alta qualidade.

✨ *Por que escolher a Honest?*
• Sucos 100% naturais
• Entrega rápida e confiável
• Preços competitivos
• Atendimento personalizado

Posso enviar nosso catálogo de produtos? 📋

_Responda esta mensagem para saber mais!_`;

      // Enviar via Evolution API
      const evolutionBaseUrl = process.env.EVOLUTION_API_BASE_URL;
      const evolutionApiKey = process.env.EVOLUTION_API_KEY;
      const instanceName = process.env.EVOLUTION_INSTANCE_NAME || 'CHAT_HONEST';

      if (!evolutionBaseUrl || !evolutionApiKey) {
        return res.status(500).json({ error: "Evolution API não configurada" });
      }

      const response = await axios.post(
        `${evolutionBaseUrl}/message/sendText/${instanceName}`,
        {
          number: cleanPhone,
          text: message
        },
        {
          headers: {
            'apikey': evolutionApiKey,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log(`✅ [SDR] Apresentação enviada para ${leadName} (${cleanPhone})`);

      res.json({ 
        success: true, 
        message: "Apresentação enviada com sucesso",
        phone: cleanPhone
      });
    } catch (error: any) {
      console.error("[SDR] Erro ao enviar apresentação:", error);
      res.status(500).json({ error: error.message || "Erro ao enviar apresentação" });
    }
  });

  // POST /api/sdr/salvar-lead - Salvar lead no CRM
  app.post("/api/sdr/salvar-lead", authenticateUser, requireRole(['admin', 'coordinator', 'telemarketing']), async (req, res) => {
    try {
      const { name, address, phone, website, rating, placeId, latitude, longitude } = req.body;
      const userId = (req.user as any)?.id;
      
      if (!name) {
        return res.status(400).json({ error: "Nome é obrigatório" });
      }

      // Verificar se já existe lead com mesmo telefone
      if (phone) {
        const cleanPhone = phone.replace(/\D/g, '');
        const existingLeads = await storage.getLeads();
        const existingByPhone = existingLeads.find(l => l.phone === cleanPhone);
        if (existingByPhone) {
          return res.status(400).json({ error: "Já existe um lead com este telefone" });
        }
      }

      // Criar lead no banco - usando schema correto
      const lead = await storage.createLead({
        fantasyName: name,
        phone: phone?.replace(/\D/g, '') || null,
        latitude: latitude || -16.6869, // Default Goiânia
        longitude: longitude || -49.2648,
        contact: address || null,
        observation: website 
          ? `Fonte: SDR Digital\nWebsite: ${website}\nRating: ${rating || 'N/A'}\nGoogle Place ID: ${placeId}` 
          : `Fonte: SDR Digital\nRating: ${rating || 'N/A'}\nGoogle Place ID: ${placeId}`,
        status: 'pending',
        createdBy: userId
      });

      console.log(`✅ [SDR] Lead salvo: ${name}`);

      res.json({ 
        success: true, 
        lead,
        message: "Lead salvo com sucesso"
      });
    } catch (error: any) {
      console.error("[SDR] Erro ao salvar lead:", error);
      res.status(500).json({ error: error.message || "Erro ao salvar lead" });
    }
  });

  console.log("✅ SDR Digital routes registered successfully");
}

function getCategoryLabel(category: string): string {
  const categories: Record<string, string> = {
    bar: 'bares',
    restaurant: 'restaurantes',
    cafe: 'cafeterias',
    bakery: 'padarias',
    supermarket: 'supermercados',
    convenience_store: 'conveniências',
    hotel: 'hotéis',
    gym: 'academias',
    store: 'lojas'
  };
  return categories[category] || category;
}
