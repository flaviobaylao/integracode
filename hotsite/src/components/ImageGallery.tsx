import { useState, useRef, type TouchEvent } from 'react';
import { ChevronLeft, ChevronRight, X, ZoomIn } from 'lucide-react';

interface ImageGalleryProps {
  images: string[];
  productName: string;
}

export default function ImageGallery({ images, productName }: ImageGalleryProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isZoomed, setIsZoomed] = useState(false);
  
  // Touch swipe handlers for mobile navigation
  const touchStartX = useRef<number>(0);
  const touchEndX = useRef<number>(0);
  const isSingleTouch = useRef<boolean>(false);
  
  const handleTouchStart = (e: TouchEvent<HTMLDivElement>) => {
    // Only handle single-touch gestures (not pinch-to-zoom)
    if (e.touches.length === 1) {
      touchStartX.current = e.touches[0].clientX;
      touchEndX.current = e.touches[0].clientX; // Reset to avoid stale values
      isSingleTouch.current = true;
    } else {
      isSingleTouch.current = false;
    }
  };
  
  const handleTouchMove = (e: TouchEvent<HTMLDivElement>) => {
    // Only track movement for single-touch gestures
    if (e.touches.length === 1 && isSingleTouch.current) {
      touchEndX.current = e.touches[0].clientX;
    }
  };
  
  const handleTouchEnd = () => {
    // Only swipe if this was a single-touch gesture
    if (!isSingleTouch.current) return;
    
    const swipeThreshold = 50; // Minimum distance for swipe
    const diff = touchStartX.current - touchEndX.current;
    
    if (Math.abs(diff) > swipeThreshold) {
      if (diff > 0) {
        // Swiped left - next image
        goToNext();
      } else {
        // Swiped right - previous image
        goToPrevious();
      }
    }
    
    // Reset flags
    isSingleTouch.current = false;
  };

  if (!images || images.length === 0) {
    return (
      <div className="bg-gray-200 rounded-xl aspect-square flex items-center justify-center">
        <span className="text-gray-400">Sem imagem</span>
      </div>
    );
  }

  const goToPrevious = () => {
    setCurrentIndex((prev) => (prev === 0 ? images.length - 1 : prev - 1));
  };

  const goToNext = () => {
    setCurrentIndex((prev) => (prev === images.length - 1 ? 0 : prev + 1));
  };

  const goToImage = (index: number) => {
    setCurrentIndex(index);
  };

  const openZoom = () => {
    setIsZoomed(true);
  };

  const closeZoom = () => {
    setIsZoomed(false);
  };

  return (
    <>
      {/* Galeria principal */}
      <div className="relative">
        {/* Imagem atual */}
        <div 
          className="relative bg-white rounded-xl overflow-hidden aspect-square cursor-zoom-in"
          onClick={openZoom}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          data-testid="gallery-main-image"
        >
          <img
            src={images[currentIndex]}
            alt={`${productName} - Imagem ${currentIndex + 1}`}
            className="w-full h-full object-cover"
          />
          
          {/* Ícone de zoom */}
          <div className="absolute top-4 right-4 bg-black/50 p-2 rounded-full">
            <ZoomIn className="w-5 h-5 text-white" />
          </div>

          {/* Badge com contador de imagens */}
          {images.length > 1 && (
            <div className="absolute bottom-4 left-4 bg-black/70 text-white px-3 py-1 rounded-full text-sm">
              {currentIndex + 1} / {images.length}
            </div>
          )}
        </div>

        {/* Setas de navegação (apenas se tiver mais de 1 imagem) */}
        {images.length > 1 && (
          <>
            <button
              onClick={goToPrevious}
              className="absolute left-2 top-1/2 -translate-y-1/2 bg-white/90 hover:bg-white p-2 rounded-full shadow-lg transition-all"
              aria-label="Imagem anterior"
              data-testid="gallery-prev-button"
            >
              <ChevronLeft className="w-6 h-6 text-gray-800" />
            </button>
            
            <button
              onClick={goToNext}
              className="absolute right-2 top-1/2 -translate-y-1/2 bg-white/90 hover:bg-white p-2 rounded-full shadow-lg transition-all"
              aria-label="Próxima imagem"
              data-testid="gallery-next-button"
            >
              <ChevronRight className="w-6 h-6 text-gray-800" />
            </button>
          </>
        )}

        {/* Indicadores (bolinhas) */}
        {images.length > 1 && (
          <div className="flex justify-center gap-2 mt-4">
            {images.map((_, index) => (
              <button
                key={index}
                onClick={() => goToImage(index)}
                className={`transition-all rounded-full ${
                  index === currentIndex
                    ? 'bg-honest-green w-8 h-2'
                    : 'bg-gray-300 w-2 h-2 hover:bg-gray-400'
                }`}
                aria-label={`Ir para imagem ${index + 1}`}
                data-testid={`gallery-indicator-${index}`}
              />
            ))}
          </div>
        )}
      </div>

      {/* Modal de zoom */}
      {isZoomed && (
        <div 
          className="fixed inset-0 bg-black/95 z-50 flex items-center justify-center p-4"
          onClick={closeZoom}
          data-testid="gallery-zoom-modal"
        >
          {/* Botão fechar */}
          <button
            onClick={closeZoom}
            className="absolute top-4 right-4 bg-white/20 hover:bg-white/30 p-2 rounded-full transition-all"
            aria-label="Fechar zoom"
            data-testid="gallery-close-zoom"
          >
            <X className="w-6 h-6 text-white" />
          </button>

          {/* Imagem em tamanho grande */}
          <div 
            className="relative max-w-4xl max-h-full" 
            onClick={(e) => e.stopPropagation()}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          >
            <img
              src={images[currentIndex]}
              alt={`${productName} - Imagem ${currentIndex + 1} (ampliada)`}
              className="max-w-full max-h-[90vh] object-contain"
            />

            {/* Setas de navegação no zoom */}
            {images.length > 1 && (
              <>
                <button
                  onClick={(e) => { e.stopPropagation(); goToPrevious(); }}
                  className="absolute left-4 top-1/2 -translate-y-1/2 bg-white/30 hover:bg-white/50 p-3 rounded-full transition-all"
                  aria-label="Imagem anterior"
                >
                  <ChevronLeft className="w-8 h-8 text-white" />
                </button>
                
                <button
                  onClick={(e) => { e.stopPropagation(); goToNext(); }}
                  className="absolute right-4 top-1/2 -translate-y-1/2 bg-white/30 hover:bg-white/50 p-3 rounded-full transition-all"
                  aria-label="Próxima imagem"
                >
                  <ChevronRight className="w-8 h-8 text-white" />
                </button>
              </>
            )}

            {/* Contador no zoom */}
            {images.length > 1 && (
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/70 text-white px-4 py-2 rounded-full">
                {currentIndex + 1} / {images.length}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
