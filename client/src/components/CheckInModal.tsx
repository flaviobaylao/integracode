import { useState, useRef, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Camera, MapPin, Loader2, Mic } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { getBrazilDateISO } from "@/lib/brazilTimezone";

interface CheckInModalProps {
  isOpen: boolean;
  onClose: () => void;
  cardId: string;
  customerLatitude?: string | null;
  customerLongitude?: string | null;
  onSuccess: () => void;
  // Débito em aberto do cliente: quando > 0, o check-in mostra a caixa de explicação
  // do débito (com microfone). Justificado aqui, não vira pendência no fechamento.
  customerId?: string | null;
  sellerId?: string | null;
  debt?: number;
}

export default function CheckInModal({
  isOpen,
  onClose,
  cardId,
  customerLatitude,
  customerLongitude,
  onSuccess,
  customerId,
  sellerId,
  debt = 0,
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
  // GPS falhou (permissao negada / ambiente fechado / timeout): libera seguir p/ a camera
  // mesmo sem localizacao, para o check-in nao ficar travado.
  const [locFailed, setLocFailed] = useState(false);
  // Captura de localizacao em andamento: trava cliques repetidos (que reiniciavam a
  // busca do zero e deixavam o botao "sem efeito") e mostra o spinner de progresso.
  const [capturing, setCapturing] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Explicação do débito (quando o cliente tem débito em aberto). Transcrição por voz (pt-BR).
  const hasDebt = Number(debt) > 0;
  const [debtNote, setDebtNote] = useState('');
  const [gravando, setGravando] = useState(false);
  const recRef = useRef<any>(null);
  const debtBaseRef = useRef<string>('');
  const toggleGravacao = () => {
    const SR = (typeof window !== 'undefined') ? ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition) : null;
    if (!SR) { toast({ title: 'Gravação de áudio não suportada neste navegador', description: 'Abra pelo Chrome do celular para usar a transcrição.', variant: 'destructive' }); return; }
    if (gravando && recRef.current) { try { recRef.current.stop(); } catch {} return; }
    // Só um microfone por vez: para a gravação das Observações, se estiver ativa.
    if (gravandoNotes && notesRecRef.current) { try { notesRecRef.current.stop(); } catch {} }
    try {
      const r = new SR();
      r.lang = 'pt-BR'; r.interimResults = true; r.continuous = true;
      debtBaseRef.current = debtNote ? debtNote.trim() + ' ' : '';
      r.onresult = (e: any) => { let t = ''; for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript; setDebtNote(debtBaseRef.current + t); };
      r.onerror = () => { setGravando(false); recRef.current = null; };
      r.onend = () => { setGravando(false); recRef.current = null; };
      recRef.current = r; r.start(); setGravando(true);
    } catch { setGravando(false); recRef.current = null; toast({ title: 'Não foi possível iniciar a gravação', variant: 'destructive' }); }
  };

  // 🎙️ Ditado por voz (transcrição pt-BR) para a caixa de OBSERVAÇÕES do check-in — mesma
  // tecnologia da explicação de débito (Web Speech API do navegador). Anexa ao texto já digitado.
  const [gravandoNotes, setGravandoNotes] = useState(false);
  const notesRecRef = useRef<any>(null);
  const notesBaseRef = useRef<string>('');
  const toggleGravacaoNotes = () => {
    const SR = (typeof window !== 'undefined') ? ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition) : null;
    if (!SR) { toast({ title: 'Gravação de áudio não suportada neste navegador', description: 'Abra pelo Chrome do celular para usar a transcrição.', variant: 'destructive' }); return; }
    if (gravandoNotes && notesRecRef.current) { try { notesRecRef.current.stop(); } catch {} return; }
    // Só um microfone por vez: para a gravação do débito, se estiver ativa.
    if (gravando && recRef.current) { try { recRef.current.stop(); } catch {} }
    try {
      const r = new SR();
      r.lang = 'pt-BR'; r.interimResults = true; r.continuous = true;
      notesBaseRef.current = notes ? notes.trim() + ' ' : '';
      r.onresult = (e: any) => { let t = ''; for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript; setNotes(notesBaseRef.current + t); };
      r.onerror = () => { setGravandoNotes(false); notesRecRef.current = null; };
      r.onend = () => { setGravandoNotes(false); notesRecRef.current = null; };
      notesRecRef.current = r; r.start(); setGravandoNotes(true);
    } catch { setGravandoNotes(false); notesRecRef.current = null; toast({ title: 'Não foi possível iniciar a gravação', variant: 'destructive' }); }
  };

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
    if (capturing) return; // ja esta buscando: ignora cliques repetidos que reiniciavam a captura
    setStep('location');
    setLocFailed(false);
    setCapturing(true);

    try {
      if (!navigator.geolocation) {
        throw { code: 2, message: 'Dispositivo sem suporte a geolocalização' };
      }
      const getPos = (opts: PositionOptions) => new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, opts);
      });
      let position: GeolocationPosition;
      try {
        // 1a tentativa: aceita um fix recente em cache (resolve NA HORA se o navegador ja tem
        // posicao, ex. do mapa da rota) — funciona bem em ambiente fechado (supermercado).
        position = await getPos({ enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 });
      } catch (e1) {
        // 2a: alta precisao (GPS) com tempo suficiente para pegar o fix estando no cliente.
        position = await getPos({ enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
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
      // Nao bloqueia o check-in: libera o botao "Continuar sem localizacao" p/ abrir a camera.
      setLocFailed(true);
    } finally {
      setCapturing(false);
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

  // Comprime/redimensiona a foto p/ upload confiavel no mobile (evita estourar o limite de 10MB
  // do servidor e acelera o envio em conexao fraca). Max 1280px no maior lado, JPEG ~0,72.
  const compressImage = (src: string, maxSide = 1280, quality = 0.72): Promise<string> =>
    new Promise((resolve) => {
      try {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          const cx = c.getContext('2d');
          if (!cx) { resolve(src); return; }
          cx.drawImage(img, 0, 0, w, h);
          resolve(c.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => resolve(src);
        img.src = src;
      } catch { resolve(src); }
    });

  // Tirar foto (a partir do preview ao vivo)
  const takePhoto = async () => {
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
      const photo = await compressImage(canvas.toDataURL('image/jpeg'));
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
      reader.onload = async (ev) => {
        const photo = await compressImage(ev.target?.result as string);
        setPhotoData(photo);
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
    // Localizacao e opcional: exige apenas a foto. Quando o GPS funciona, as coordenadas vao junto.
    if (!photoData) return;

    setStep('submitting');

    try {
      // Converter base64 para blob
      const response = await fetch(photoData);
      const blob = await response.blob();

      // Criar FormData
      const formData = new FormData();
      formData.append('photo', blob, 'checkin.jpg');
      if (location) {
        formData.append('latitude', location.latitude.toString());
        formData.append('longitude', location.longitude.toString());
      }
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

      // Débito explicado no check-in: registra como justificativa (motivo "debito").
      // Assim o cliente NÃO entra na pendência do Fechar Rota do dia.
      if (hasDebt && debtNote.trim() && customerId && sellerId) {
        try {
          await fetch('/api/vendedor/justificativas', {
            method: 'POST', credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ date: getBrazilDateISO(), customerId, sellerId, reason: 'debito', notes: debtNote.trim() }),
          });
        } catch { /* não bloqueia o check-in */ }
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
    setDebtNote('');
    if (gravando && recRef.current) { try { recRef.current.stop(); } catch {} }
    setCameraError(false);
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
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
              <Button onClick={captureLocation} disabled={capturing} data-testid="button-capture-location">
                {capturing ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Capturando...</>
                ) : (
                  <><MapPin className="mr-2 h-4 w-4" /> {locFailed ? 'Tentar Localização Novamente' : 'Capturar Localização'}</>
                )}
              </Button>

              {capturing && (
                <p className="text-xs text-gray-500 mt-3">
                  Buscando o sinal de GPS. Pode levar alguns segundos. Mantenha esta tela aberta e nao clique varias vezes.
                </p>
              )}

              {/* Se o GPS falhar (ambiente fechado / permissao negada), NAO travar o check-in:
                  segue para a camera mesmo sem coordenadas. */}
              {locFailed && (
                <div className="mt-4">
                  <p className="text-xs text-amber-700 mb-2">
                    Não foi possível obter sua localização. Você pode continuar e registrar a foto do check-in mesmo assim.
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => { setLocation(null); setDistance(null); setStep('photo'); }}
                    data-testid="button-continue-without-location"
                  >
                    <Camera className="mr-2 h-4 w-4" />
                    Continuar sem localização
                  </Button>
                </div>
              )}
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
                <div className="relative">
                  <textarea
                    placeholder="Relatar o ocorrido na visita (pode ditar pelo microfone) (opcional)"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    className="w-full h-20 p-2 pr-11 border rounded-lg dark:bg-gray-900 dark:border-gray-700 text-sm"
                    data-testid="textarea-checkin-notes"
                  />
                  <button
                    type="button"
                    onClick={toggleGravacaoNotes}
                    className={`absolute right-2 top-2 rounded-full p-1.5 ${gravandoNotes ? 'bg-blue-600 text-white animate-pulse' : 'bg-white text-blue-600 border border-blue-300'}`}
                    aria-label={gravandoNotes ? 'Parar gravação' : 'Ditar observações'}
                    data-testid="button-mic-notes"
                  >
                    <Mic className="h-4 w-4" />
                  </button>
                </div>
                {gravandoNotes && <div className="text-[11px] text-blue-600 dark:text-blue-300 mt-1">Gravando… fale a observação.</div>}
              </div>

              {hasDebt && (
                <div className="border border-red-200 bg-red-50 dark:bg-red-950/30 dark:border-red-900 rounded-lg p-3">
                  <div className="text-sm font-bold text-red-700 dark:text-red-300 mb-1">
                    💰 Débito em aberto: R$ {Number(debt).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                  </div>
                  <label className="block text-xs text-red-800 dark:text-red-300 mb-1">
                    Explique o débito. Ao justificar aqui, o cliente não entra na pendência do fechamento da rota.
                  </label>
                  <div className="relative">
                    <textarea
                      placeholder="Explique a situação do débito (pode ditar pelo microfone)…"
                      value={debtNote}
                      onChange={(e) => setDebtNote(e.target.value)}
                      className="w-full h-20 p-2 pr-11 border rounded-lg dark:bg-gray-900 dark:border-gray-700 text-sm"
                      data-testid="textarea-checkin-debito"
                    />
                    <button
                      type="button"
                      onClick={toggleGravacao}
                      className={`absolute right-2 top-2 rounded-full p-1.5 ${gravando ? 'bg-red-600 text-white animate-pulse' : 'bg-white text-red-600 border border-red-300'}`}
                      aria-label={gravando ? 'Parar gravação' : 'Ditar explicação'}
                      data-testid="button-mic-debito"
                    >
                      <Mic className="h-4 w-4" />
                    </button>
                  </div>
                  {gravando && <div className="text-[11px] text-red-600 dark:text-red-300 mt-1">Gravando… fale a explicação do débito.</div>}
                </div>
              )}

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
