import { useState, useEffect } from 'react';
import { Star } from 'lucide-react';

interface Review {
  id: string;
  customerName: string;
  rating: number;
  comment: string | null;
  createdAt: string;
}

interface ReviewStats {
  averageRating: number;
  totalReviews: number;
  ratingDistribution: {
    1: number;
    2: number;
    3: number;
    4: number;
    5: number;
  };
}

interface ProductReviewsProps {
  productId: string;
  productName: string;
}

export default function ProductReviews({ productId, productName }: ProductReviewsProps) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [stats, setStats] = useState<ReviewStats | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  
  // Form state
  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [hoverRating, setHoverRating] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    loadReviews();
    loadStats();
  }, [productId]);

  const loadReviews = async () => {
    try {
      const response = await fetch(`/api/public/products/${productId}/reviews`);
      if (response.ok) {
        const data = await response.json();
        setReviews(data);
      }
    } catch (error) {
      console.error('Erro ao carregar avaliações:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const loadStats = async () => {
    try {
      const response = await fetch(`/api/public/products/${productId}/review-stats`);
      if (response.ok) {
        const data = await response.json();
        setStats(data);
      }
    } catch (error) {
      console.error('Erro ao carregar estatísticas:', error);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!customerName.trim()) {
      alert('Por favor, digite seu nome');
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch('/api/public/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId,
          customerName: customerName.trim(),
          customerEmail: customerEmail.trim() || null,
          rating,
          comment: comment.trim() || null
        })
      });

      if (response.ok) {
        alert('Avaliação enviada! Ela será publicada após moderação. Obrigado!');
        setShowForm(false);
        setCustomerName('');
        setCustomerEmail('');
        setRating(5);
        setComment('');
      } else {
        const error = await response.json();
        alert(error.message || 'Erro ao enviar avaliação');
      }
    } catch (error) {
      console.error('Erro ao enviar avaliação:', error);
      alert('Erro ao enviar avaliação. Tente novamente.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const renderStars = (rating: number, size = 'w-5 h-5') => {
    return (
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((star) => (
          <Star
            key={star}
            className={`${size} ${
              star <= rating 
                ? 'fill-yellow-400 text-yellow-400' 
                : 'fill-gray-200 text-gray-200'
            }`}
          />
        ))}
      </div>
    );
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('pt-BR', { 
      day: '2-digit', 
      month: 'long', 
      year: 'numeric' 
    });
  };

  return (
    <div className="space-y-6">
      {/* Estatísticas */}
      {stats && stats.totalReviews > 0 && (
        <div className="bg-white rounded-xl p-6 shadow-sm">
          <div className="flex items-center gap-6 mb-4">
            <div className="text-center">
              <div className="text-4xl font-bold text-honest-green">
                {stats.averageRating.toFixed(1)}
              </div>
              {renderStars(Math.round(stats.averageRating))}
              <div className="text-sm text-gray-600 mt-1">
                {stats.totalReviews} {stats.totalReviews === 1 ? 'avaliação' : 'avaliações'}
              </div>
            </div>

            {/* Distribuição de estrelas */}
            <div className="flex-1 space-y-2">
              {[5, 4, 3, 2, 1].map((star) => (
                <div key={star} className="flex items-center gap-2 text-sm">
                  <span className="w-6">{star}</span>
                  <Star className="w-4 h-4 fill-yellow-400 text-yellow-400" />
                  <div className="flex-1 bg-gray-200 rounded-full h-2">
                    <div
                      className="bg-yellow-400 h-2 rounded-full transition-all"
                      style={{
                        width: `${
                          stats.totalReviews > 0
                            ? (stats.ratingDistribution[star as keyof typeof stats.ratingDistribution] / stats.totalReviews) * 100
                            : 0
                        }%`
                      }}
                    />
                  </div>
                  <span className="w-8 text-right text-gray-600">
                    {stats.ratingDistribution[star as keyof typeof stats.ratingDistribution]}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Botão para avaliar */}
      {!showForm && (
        <button
          onClick={() => setShowForm(true)}
          className="w-full bg-honest-green text-white py-3 rounded-xl font-semibold hover:bg-green-700 transition-colors"
          data-testid="button-show-review-form"
        >
          ⭐ Avaliar este produto
        </button>
      )}

      {/* Formulário de avaliação */}
      {showForm && (
        <div className="bg-white rounded-xl p-6 shadow-sm">
          <h3 className="font-bold text-lg mb-4">Avalie {productName}</h3>
          
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Nome */}
            <div>
              <label className="block text-sm font-medium mb-1">
                Nome <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                className="w-full p-3 border rounded-lg"
                placeholder="Seu nome"
                required
                data-testid="input-review-name"
              />
            </div>

            {/* Email (opcional) */}
            <div>
              <label className="block text-sm font-medium mb-1">
                Email (opcional)
              </label>
              <input
                type="email"
                value={customerEmail}
                onChange={(e) => setCustomerEmail(e.target.value)}
                className="w-full p-3 border rounded-lg"
                placeholder="seu@email.com"
                data-testid="input-review-email"
              />
            </div>

            {/* Avaliação com estrelas */}
            <div>
              <label className="block text-sm font-medium mb-2">
                Nota <span className="text-red-500">*</span>
              </label>
              <div className="flex gap-2">
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    type="button"
                    onClick={() => setRating(star)}
                    onMouseEnter={() => setHoverRating(star)}
                    onMouseLeave={() => setHoverRating(0)}
                    className="transition-transform hover:scale-110"
                    data-testid={`button-rating-${star}`}
                  >
                    <Star
                      className={`w-10 h-10 ${
                        star <= (hoverRating || rating)
                          ? 'fill-yellow-400 text-yellow-400'
                          : 'fill-gray-200 text-gray-200'
                      }`}
                    />
                  </button>
                ))}
              </div>
            </div>

            {/* Comentário */}
            <div>
              <label className="block text-sm font-medium mb-1">
                Comentário (opcional)
              </label>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                className="w-full p-3 border rounded-lg resize-none"
                rows={4}
                placeholder="Conte sua experiência com o produto..."
                data-testid="input-review-comment"
              />
            </div>

            {/* Botões */}
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="flex-1 border border-gray-300 text-gray-700 py-3 rounded-xl font-semibold hover:bg-gray-50 transition-colors"
                data-testid="button-cancel-review"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="flex-1 bg-honest-green text-white py-3 rounded-xl font-semibold hover:bg-green-700 transition-colors disabled:opacity-50"
                data-testid="button-submit-review"
              >
                {isSubmitting ? 'Enviando...' : 'Enviar Avaliação'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Lista de avaliações */}
      {isLoading ? (
        <div className="text-center py-8 text-gray-500">
          Carregando avaliações...
        </div>
      ) : reviews.length > 0 ? (
        <div className="space-y-4">
          <h3 className="font-bold text-lg">Avaliações dos clientes</h3>
          {reviews.map((review) => (
            <div 
              key={review.id} 
              className="bg-white rounded-xl p-4 shadow-sm"
              data-testid={`review-${review.id}`}
            >
              <div className="flex items-start justify-between mb-2">
                <div>
                  <div className="font-semibold">{review.customerName}</div>
                  <div className="text-sm text-gray-500">{formatDate(review.createdAt)}</div>
                </div>
                {renderStars(review.rating, 'w-4 h-4')}
              </div>
              {review.comment && (
                <p className="text-gray-700 mt-2">{review.comment}</p>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="text-center py-8 bg-gray-50 rounded-xl">
          <p className="text-gray-500">Nenhuma avaliação ainda.</p>
          <p className="text-gray-500 text-sm mt-1">Seja o primeiro a avaliar este produto!</p>
        </div>
      )}
    </div>
  );
}
