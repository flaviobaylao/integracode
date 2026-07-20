import { useState, useRef, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Camera, MapPin, Loader2 } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";

interface CheckInModalProps {
  isOpen: boolean;
  onClose: () => void;
  cardId: string;
  customerLatitude?: string | null;
  customerLongitude?: string | null;
  onSuccess: () => void;
}

export default function CheckInModal({ 
  isOpen, 
  onClose, 
  cardId, 
  customerLatitude, 
  customerLongitude, 
  onSuccess 
}: CheckInModalProps) {
  const { toast } = useToast();
  const { user } = useAuth();
  // Upload de foto do arquivo só para administradores; os demais seguem a câmera (regra atual).
  const CHECKIN_ADMINS = ['cinthiamarque90@gmail.com', 'flavio@bebahonest.com.br', 'flaviobaylao@gmail.com'];
  const isCheckinAdmin = CHECKIN_ADMINS.includes(((user as any)?.email || '').toLowerCase().trim());
  const [step, setStep] = useState<'location' | 'photo' | 'submitting'>('location');
  const [location, setLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [distance, setDistance] = useState<number | null>(null);
  const [photoData, setPhotoData] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [cameraError, setCameraError] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Calcular distância usando Haversine
  const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
    const R = 6371000; // Raio da Terra em metros
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
      Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  };

  // Capturar localização
  const captureLocation = async () => {
    setStep('location');
    
    try {
      if (!navigator.geolocation) {
        throw { code: 2, message: 'Dispositivo sem suporte a geolocalização' };
      }
      const getPos = (opts: PositionOptions) => new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, opts);
      });
      let position: GeolocationPosition;
      try {
        // 1a tentativa: aceita posicao recente em cache (rede/wifi) — resolve NA HORA se o navegador
        // ja tem um fix (ex. do mapa da rota) e funciona bem em ambiente fechado (supermercado)
        position = await getPos({ enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 });
      } catch (e1) {
        try {
          // 2a: alta precisao (GPS) com tempo maior
          position = await getPos({ enableHighAccuracy: true, timeout: 25000, maximumAge: 60000 });
        } catch (e2) {
          // 3a (ultima): qualquer posicao em cache, baixa precisao, tempo longo — o mais tolerante possivel
          position = await getPos({ enableHighAccuracy: false, timeout: 30000, maximumAge: 600000 });
        }
      }

      const loc = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude
      };
      setLocation(loc);

      // Calcular distância se houver coordenadas do cliente
      if (customerLatitude && customerLongitude) {
        const dist = calculateDistance(
          loc.latitude,
          loc.longitude,
          parseFloat(customerLatitude),
          parseFloat(customerLongitude)
        );
        setDistance(dist);
      }

      // Ir para o próximo passo (foto). A câmera é ligada por um useEffect quando o passo
      // vira 'photo' — assim o elemento <video> já está montado antes de receber o stream
      // (antes a câmera era iniciada cedo demais e o preview às vezes nunca aparecia).
      setStep('photo');
    } catch (error: any) {
      const code = error?.code;
      const description =
        code === 1 ? 'Permissão de localização negada. Ative o GPS e permita o acesso à localização deste site nas configurações do navegador.'
        : code === 2 ? 'Localização indisponível. Verifique se o GPS está ligado e tente novamente (de preferência próximo a uma janela ou ao ar livre).'
        : code === 3 ? 'Tempo esgotado ao obter a localização. Verifique se o GPS está ligado e tente novamente.'
        : (error?.message || 'Erro desconhecido');
      toast({
        title: "Erro ao capturar localização",
        description,
        variant: "destructive"
      });
    }
  };

  // Liga a câmera ao vivo APENAS quando o passo é 'photo' e ainda não há foto — e só
  // depois que o <video> já está montado (efeito roda pós-render). Isso corrige o caso
  // em que a câmera era iniciada antes do elemento existir e o preview ficava preto.
  useEffect(() => {
    if (!isOpen || step !== 'photo' || photoData) return;
    let cancelled = false;
    let localStream: MediaStream | null = null;
    (async () => {
      setCameraError(false);
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('Câmera não disponível neste navegador');
        }
        localStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' }, // câmera traseira
          audio: false,
        });
        if (cancelled) { localStream.getTracks().forEach((t) => t.stop()); return; }
        setStream(localStream);
        const v = videoRef.current;
        if (v) {
          v.srcObject = localStream;
          v.muted = true; // autoplay em mobile exige muted
          v.setAttribute('playsinline', 'true');
          try { await v.play(); } catch { /* alguns navegadores exigem gesto; preview ainda aparece */ }
        }
      } catch (err) {
        if (!cancelled) setCameraError(true); // cai no caminho de captura nativa (fallback)
      }
    })();
    return () => {
      cancelled = true;
      if (localStream) localStream.getTracks().forEach((t) => t.stop());
    };
  }, [isOpen, step, photoData]);

  // Tirar foto (a partir do preview ao vivo)
  const takePhoto = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth || !v.videoHeight) {
      toast({
        title: "Câmera ainda não está pronta",
        description: 'Aguarde o preview aparecer ou use "Tirar foto pela câmera do aparelho".',
        variant: "destructive",
      });
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(v, 0, 0);
      const photo = canvas.toDataURL('image/jpeg');
      setPhotoData(photo);
      // Parar câmera (o useEffect também limpa ao sair do passo)
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
        setStream(null);
      }
    }
  };

  // Captura pela câmera nativa do aparelho (input file com capture) — funciona mesmo
  // quando o preview ao vivo falha. Força a câmera (não a galeria) via capture="environment".
  const onNativeCapture = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        setPhotoData(ev.target?.result as string);
        if (stream) { stream.getTracks().forEach((t) => t.stop()); setStream(null); }
      };
      reader.readAsDataURL(f);
    }
    (e.target as HTMLInputElement).value = '';
  };

  // Refazer foto — limpa a foto; o useEffect religa a câmera automaticamente.
  const retakePhoto = () => {
    setPhotoData(null);
    setCameraError(false);
  };

  // Enviar check-in
  const submitCheckIn = async () => {
    if (!location || !photoData) return;

    setStep('submitting');

    try {
      // Converter base64 para blob
      const response = await fetch(photoData);
      const blob = await response.blob();

      // Criar FormData
      const formData = new FormData();
      formData.append('photo', blob, 'checkin.jpg');
      formData.append('latitude', location.latitude.toString());
      formData.append('longitude', location.longitude.toString());
      if (notes.trim()) {
        formData.append('notes', notes.trim());
      }

      // Enviar para o backend
      const checkInResponse = await fetch(`/api/sales-cards/${cardId}/check-in`, {
        method: 'POST',
        credentials: 'include',
        body: formData
      });

      if (!checkInResponse.ok) {
        throw new Error('Erro ao realizar check-in');
      }

      toast({
        title: "Check-in realizado!",
        description: distance 
          ? `Distância: ${distance.toFixed(0)}m do cliente` 
          : "Check-in registrado com sucesso"
      });

      onSuccess();
      handleClose();
    } catch (error) {
      toast({
        title: "Erro ao realizar check-in",
        description: error instanceof Error ? error.message : "Erro desconhecido",
        variant: "destructive"
      });
      setStep('photo');
    }
  };

  // Fechar e limpar
  const handleClose = () => {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      setStream(null);
    }
    setStep('location');
    setLocation(null);
    setDistance(null);
    setPhotoData(null);
    setNotes('');
    setCameraError(false);
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Check-in no Cliente</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {step === 'location' && (
            <div className="text-center py-8">
              <MapPin className="h-16 w-16 mx-auto mb-4 text-blue-500" />
              <h3 className="text-lg font-semibold mb-2">Capturar Localização</h3>
              <p className="text-gray-600 mb-6">
                Primeiro, vamos capturar sua localização para registrar o check-in
              </p>
              <Button onClick={captureLocation} data-testid="button-capture-location">
                <MapPin className="mr-2 h-4 w-4" />
                Capturar Localização
              </Button>
            </div>
          )}

          {step === 'photo' && !photoData && (
            <div className="space-y-4">
              {distance !== null && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-center">
                  <p className="text-sm text-blue-800">
                    📍 Distância do cliente: <strong>{distance.toFixed(0)}m</strong>
                  </p>
                </div>
              )}
              
              {!cameraError ? (
                <>
                  <div className="relative bg-black rounded-lg overflow-hidden aspect-video">
                    <video
                      ref={videoRef}
                      autoPlay
                      playsInline
                      muted
                      className="w-full h-full object-cover"
                      data-testid="video-camera"
                    />
                  </div>

                  <Button onClick={takePhoto} className="w-full" data-testid="button-take-photo">
                    <Camera className="mr-2 h-4 w-4" />
                    Tirar Foto
                  </Button>
                </>
              ) : (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800 text-center">
                  Não foi possível abrir a câmera ao vivo neste aparelho. Toque no botão abaixo para tirar a foto pela câmera do celular.
                </div>
              )}

              {/* 📸 Captura pela câmera do aparelho — SEMPRE disponível (garantia caso o
                  preview ao vivo não abra). capture="environment" força a câmera (não a galeria). */}
              <label
                className={`w-full inline-flex items-center justify-center gap-2 text-sm rounded-md px-3 py-2 cursor-pointer ${cameraError ? 'bg-blue-600 text-white hover:bg-blue-700' : 'border border-blue-300 text-blue-700 hover:bg-blue-50'}`}
                data-testid="native-capture-checkin-photo"
              >
                <Camera className="h-4 w-4" />
                {cameraError ? 'Tirar foto (câmera do aparelho)' : 'Câmera não abriu? Tirar foto pelo app do celular'}
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={onNativeCapture}
                />
              </label>

              {/* 📤 Upload de foto do arquivo (galeria) — SOMENTE administradores */}
              {isCheckinAdmin && (
                <label
                  className="w-full inline-flex items-center justify-center gap-2 text-sm border border-purple-300 text-purple-700 rounded-md px-3 py-2 cursor-pointer hover:bg-purple-50"
                  data-testid="admin-upload-checkin-photo"
                >
                  📤 Enviar foto do arquivo (Adm)
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={onNativeCapture}
                  />
                </label>
              )}
            </div>
          )}

          {step === 'photo' && photoData && (
            <div className="space-y-4">
              {distance !== null && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-center">
                  <p className="text-sm text-blue-800">
                    📍 Distância do cliente: <strong>{distance.toFixed(0)}m</strong>
                  </p>
                </div>
              )}

              <div className="relative rounded-lg overflow-hidden">
                <img src={photoData} alt="Check-in" className="w-full" data-testid="img-checkin-photo" />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">📝 Observações</label>
                <textarea
                  placeholder="Relatar o ocorrido na visita (opcional)"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full h-20 p-2 border rounded-lg dark:bg-gray-900 dark:border-gray-700 text-sm"
                  data-testid="textarea-checkin-notes"
                />
              </div>

              <div className="flex gap-2">
                <Button variant="outline" onClick={retakePhoto} className="flex-1" data-testid="button-retake-photo">
                  Refazer Foto
                </Button>
                <Button onClick={submitCheckIn} className="flex-1" data-testid="button-confirm-checkin">
                  Confirmar Check-in
                </Button>
              </div>
            </div>
          )}

          {step === 'submitting' && (
            <div className="text-center py-8">
              <Loader2 className="h-16 w-16 mx-auto mb-4 animate-spin text-blue-500" />
              <p className="text-gray-600">Enviando check-in...</p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
