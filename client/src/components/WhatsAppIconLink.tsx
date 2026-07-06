import React from 'react';

interface Props {
  phone?: string | null;
  customerName?: string | null;
  customerId?: string | null;
  testIdSuffix?: string | null;
}

// Versao minima (2.0): link direto de WhatsApp a partir do telefone.
export default function WhatsAppIconLink({ phone, customerName, testIdSuffix }: Props) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  const withCountry = digits.length <= 11 ? '55' + digits : digits;
  const href = 'https://wa.me/' + withCountry;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={customerName ? 'WhatsApp: ' + customerName : 'WhatsApp'}
      data-testid={testIdSuffix ? 'wa-' + testIdSuffix : 'wa-link'}
      style={{ display: 'inline-flex', alignItems: 'center', color: '#25D366' }}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
        <path d="M20.52 3.48A11.87 11.87 0 0012.06 0C5.5 0 .16 5.34.16 11.9c0 2.1.55 4.15 1.6 5.96L0 24l6.3-1.66a11.9 11.9 0 005.75 1.47h.01c6.55 0 11.89-5.34 11.9-11.9a11.8 11.8 0 00-3.44-8.43zM12.06 21.3h-.01a9.9 9.9 0 01-5.03-1.38l-.36-.21-3.74.98 1-3.65-.24-.37a9.86 9.86 0 01-1.51-5.26c0-5.45 4.44-9.88 9.9-9.88 2.64 0 5.12 1.03 6.98 2.9a9.82 9.82 0 012.9 6.99c0 5.45-4.44 9.88-9.89 9.88zm5.42-7.4c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.96-.94 1.16-.17.2-.35.22-.64.07-.3-.15-1.26-.46-2.4-1.48-.88-.79-1.48-1.76-1.65-2.06-.17-.3-.02-.46.13-.6.13-.14.3-.35.44-.52.15-.18.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.61-.92-2.2-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.37s-1.04 1.02-1.04 2.48 1.07 2.88 1.22 3.08c.15.2 2.1 3.2 5.08 4.49.71.3 1.26.49 1.69.62.71.23 1.36.2 1.87.12.57-.09 1.76-.72 2-1.41.25-.7.25-1.29.17-1.42-.07-.12-.27-.2-.57-.35z"/>
      </svg>
    </a>
  );
}
