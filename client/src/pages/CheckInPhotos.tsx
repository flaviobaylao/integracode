import { useState } from "react";
import { useQuery } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Camera, Download, MapPin, Clock, User, Building2, Calendar, X } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { useAuth } from "@/hooks/useAuth";

interface CheckInPhoto {
  id: string;
  customerName: string;
  sellerName: string;
  checkInTime: string;
  checkInPhotoUrl: string;
  checkInLatitude: string;
  checkInLongitude: string;
  distanceToCustomer: string | null;
}

export default function CheckInPhotos() {
  const { user } = useAuth();
  const isAdmin = ['admin', 'coordinator', 'administrative'].includes(user?.role || '');
  
  const [selectedSellerId, setSelectedSellerId] = useState<string>('all');
  const [selectedPhoto, setSelectedPhoto] = useState<CheckInPhoto | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Buscar vendedores (para filtro)
  const { data: sellersData } = useQuery({
    queryKey: ['/api/users'],
    enabled: isAdmin
  });

  const sellers: any[] = sellersData?.filter((u: any) => u.role === 'vendedor') || [];

  // Buscar fotos de check-in
  const { data: photosData, isLoading } = useQuery({
    queryKey: ['/api/check-in-photos', selectedSellerId],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (selectedSellerId && selectedSellerId !== 'all') {
        params.append('sellerId', selectedSellerId);
      }
      const response = await fetch(`/api/check-in-photos?${params}`, {
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Falha ao carregar fotos');
      return response.json();
    }
  });

  const photos: CheckInPhoto[] = photosData?.photos || [];

  // Filtrar por busca
  const filteredPhotos = photos.filter(photo => 
    photo.customerName.toLowerCase().includes(searchQuery.toLowerCase()) ||
    photo.sellerName.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Função para fazer download da foto
  const downloadPhoto = (photo: CheckInPhoto) => {
    const link = document.createElement('a');
    link.href = photo.checkInPhotoUrl;
    link.download = `checkin-${photo.customerName}-${format(new Date(photo.checkInTime), 'yyyy-MM-dd-HHmm')}.jpg`;
    link.click();
  };

  return (
    <div className="container mx-auto p-6 max-w-7xl">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
          <Camera className="h-8 w-8 text-honest-blue" />
          Fotos de Check-in
        </h1>
        <p className="text-gray-600 dark:text-gray-400 mt-1">
          Visualize todas as fotos capturadas durante os check-ins dos vendedores
        </p>
      </div>

      {/* Filtros */}
      <Card className="mb-6">
        <CardContent className="pt-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Busca */}
            <div>
              <label className="block text-sm font-medium mb-2">Buscar</label>
              <Input
                placeholder="Cliente ou vendedor..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                data-testid="input-search-photos"
              />
            </div>

            {/* Filtro por vendedor (apenas admin) */}
            {isAdmin && (
              <div>
                <label className="block text-sm font-medium mb-2">Vendedor</label>
                <Select value={selectedSellerId} onValueChange={setSelectedSellerId}>
                  <SelectTrigger data-testid="select-seller">
                    <SelectValue placeholder="Todos" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos os vendedores</SelectItem>
                    {sellers.map((seller: any) => (
                      <SelectItem key={seller.id} value={seller.id}>
                        {seller.firstName} {seller.lastName || ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Estatísticas */}
            <div className="flex items-end">
              <div className="bg-blue-50 dark:bg-blue-900/20 p-3 rounded-lg w-full">
                <p className="text-sm text-blue-800 dark:text-blue-200">
                  Total: <strong>{filteredPhotos.length}</strong> foto{filteredPhotos.length !== 1 ? 's' : ''}
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Galeria de Fotos */}
      {isLoading ? (
        <div className="text-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-honest-blue mx-auto mb-4"></div>
          <p className="text-gray-600">Carregando fotos...</p>
        </div>
      ) : filteredPhotos.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Camera className="h-16 w-16 mx-auto text-gray-400 mb-4" />
            <h3 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-2">
              Nenhuma foto encontrada
            </h3>
            <p className="text-gray-500 dark:text-gray-400">
              {photos.length === 0 
                ? 'Ainda não há fotos de check-in registradas no sistema.'
                : 'Nenhuma foto corresponde aos filtros aplicados.'
              }
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredPhotos.map((photo) => (
            <Card key={photo.id} className="overflow-hidden hover:shadow-lg transition-shadow">
              <div 
                className="relative h-64 bg-gray-100 dark:bg-gray-800 cursor-pointer"
                onClick={() => setSelectedPhoto(photo)}
                data-testid={`photo-card-${photo.id}`}
              >
                {photo.checkInPhotoUrl && photo.checkInPhotoUrl.length > 100 ? (
                  <img 
                    src={photo.checkInPhotoUrl} 
                    alt={`Check-in ${photo.customerName}`}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <div className="text-center">
                      <Camera className="h-12 w-12 mx-auto text-gray-400 mb-2" />
                      <p className="text-sm text-gray-500">Foto indisponível</p>
                    </div>
                  </div>
                )}
                <div className="absolute top-2 right-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="bg-white/90 hover:bg-white"
                    onClick={(e) => {
                      e.stopPropagation();
                      downloadPhoto(photo);
                    }}
                    data-testid={`button-download-${photo.id}`}
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-honest-blue" />
                  {photo.customerName}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0 space-y-2 text-sm">
                <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400">
                  <User className="h-4 w-4" />
                  {photo.sellerName}
                </div>
                <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400">
                  <Calendar className="h-4 w-4" />
                  {format(new Date(photo.checkInTime), "dd/MM/yyyy", { locale: ptBR })}
                </div>
                <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400">
                  <Clock className="h-4 w-4" />
                  {format(new Date(photo.checkInTime), "HH:mm", { locale: ptBR })}
                </div>
                {photo.distanceToCustomer && (
                  <div className="flex items-center gap-2 text-blue-600 dark:text-blue-400">
                    <MapPin className="h-4 w-4" />
                    {Math.round(parseFloat(photo.distanceToCustomer))}m do cliente
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Modal de foto em tamanho grande */}
      <Dialog open={!!selectedPhoto} onOpenChange={() => setSelectedPhoto(null)}>
        <DialogContent className="max-w-4xl p-0">
          {selectedPhoto && (
            <div className="relative">
              <Button
                size="sm"
                variant="ghost"
                className="absolute top-2 right-2 z-10 bg-white/90 hover:bg-white"
                onClick={() => setSelectedPhoto(null)}
                data-testid="button-close-photo"
              >
                <X className="h-4 w-4" />
              </Button>
              
              {selectedPhoto.checkInPhotoUrl && selectedPhoto.checkInPhotoUrl.length > 100 ? (
                <img 
                  src={selectedPhoto.checkInPhotoUrl} 
                  alt={`Check-in ${selectedPhoto.customerName}`}
                  className="w-full max-h-[80vh] object-contain bg-black"
                />
              ) : (
                <div className="w-full h-96 flex items-center justify-center bg-gray-100">
                  <div className="text-center">
                    <Camera className="h-16 w-16 mx-auto text-gray-400 mb-4" />
                    <p className="text-gray-500">Foto indisponível</p>
                  </div>
                </div>
              )}
              
              <div className="p-6 bg-white dark:bg-gray-800">
                <h3 className="text-xl font-semibold mb-4 flex items-center gap-2">
                  <Building2 className="h-5 w-5 text-honest-blue" />
                  {selectedPhoto.customerName}
                </h3>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div className="flex items-center gap-2">
                    <User className="h-4 w-4 text-gray-500" />
                    <span>{selectedPhoto.sellerName}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Calendar className="h-4 w-4 text-gray-500" />
                    <span>{format(new Date(selectedPhoto.checkInTime), "dd/MM/yyyy", { locale: ptBR })}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-gray-500" />
                    <span>{format(new Date(selectedPhoto.checkInTime), "HH:mm:ss", { locale: ptBR })}</span>
                  </div>
                  {selectedPhoto.distanceToCustomer && (
                    <div className="flex items-center gap-2">
                      <MapPin className="h-4 w-4 text-blue-500" />
                      <span>{Math.round(parseFloat(selectedPhoto.distanceToCustomer))}m do cliente</span>
                    </div>
                  )}
                  <div className="flex items-center gap-2 col-span-2">
                    <MapPin className="h-4 w-4 text-gray-500" />
                    <span className="text-xs text-gray-600">
                      {selectedPhoto.checkInLatitude}, {selectedPhoto.checkInLongitude}
                    </span>
                  </div>
                </div>
                <div className="mt-4 flex gap-2">
                  <Button
                    onClick={() => downloadPhoto(selectedPhoto)}
                    className="flex-1"
                    data-testid="button-download-modal"
                  >
                    <Download className="mr-2 h-4 w-4" />
                    Baixar Foto
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => window.open(`https://www.google.com/maps?q=${selectedPhoto.checkInLatitude},${selectedPhoto.checkInLongitude}`, '_blank')}
                    data-testid="button-view-map"
                  >
                    <MapPin className="mr-2 h-4 w-4" />
                    Ver no Mapa
                  </Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
