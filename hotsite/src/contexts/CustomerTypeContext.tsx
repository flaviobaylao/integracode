import { createContext, useContext, useState, ReactNode } from 'react';

export type CustomerCategory = 'consumer' | 'reseller';
export type ConsumerTier = 'retail' | 'wholesale';
export type ResellerLocation = 'goiania' | 'interior' | 'brasilia';

export type PriceTable = 
  | 'retail_price'
  | 'wholesale_price' 
  | 'resale_goiania_price'
  | 'resale_interior_price'
  | 'resale_brasilia_price';

export interface CompanyData {
  cnpj: string;
  razaoSocial: string;
  nomeFantasia: string;
  endereco: string;
  cidade: string;
  estado: string;
  cep: string;
  telefone?: string;
  email?: string;
  existingCustomerId?: string; // Se já for cliente cadastrado
}

export interface ConsumerData {
  cpf: string;
  nome: string;
  endereco: string;
  telefone?: string;
  email?: string;
  existingCustomerId?: string; // Se já for cliente cadastrado
}

interface CustomerTypeContextValue {
  category: CustomerCategory | null;
  consumerTier: ConsumerTier | null;
  resellerLocation: ResellerLocation | null;
  companyData: CompanyData | null;
  consumerData: ConsumerData | null;
  priceTable: PriceTable | null;
  
  setCategory: (category: CustomerCategory) => void;
  setConsumerTier: (tier: ConsumerTier) => void;
  setResellerLocation: (location: ResellerLocation | null) => void;
  setCompanyData: (data: CompanyData | null) => void;
  setConsumerData: (data: ConsumerData | null) => void;
  reset: () => void;
  
  isSelectionComplete: boolean;
}

const CustomerTypeContext = createContext<CustomerTypeContextValue | undefined>(undefined);

export function CustomerTypeProvider({ children }: { children: ReactNode }) {
  const [category, setCategory] = useState<CustomerCategory | null>(null);
  const [consumerTier, setConsumerTier] = useState<ConsumerTier | null>(null);
  const [resellerLocation, setResellerLocation] = useState<ResellerLocation | null>(null);
  const [companyData, setCompanyData] = useState<CompanyData | null>(null);
  const [consumerData, setConsumerData] = useState<ConsumerData | null>(null);

  const getPriceTable = (): PriceTable | null => {
    if (category === 'consumer' && consumerTier) {
      return consumerTier === 'retail' ? 'retail_price' : 'wholesale_price';
    }
    if (category === 'reseller' && resellerLocation) {
      switch (resellerLocation) {
        case 'goiania':
          return 'resale_goiania_price';
        case 'interior':
          return 'resale_interior_price';
        case 'brasilia':
          return 'resale_brasilia_price';
      }
    }
    return null;
  };

  const handleSetCategory = (newCategory: CustomerCategory) => {
    setCategory(newCategory);
    setConsumerTier(null);
    setResellerLocation(null);
    setCompanyData(null);
    setConsumerData(null);
  };

  const reset = () => {
    setCategory(null);
    setConsumerTier(null);
    setResellerLocation(null);
    setCompanyData(null);
    setConsumerData(null);
  };

  const isSelectionComplete = 
    (category === 'consumer' && consumerTier !== null) ||
    (category === 'reseller' && resellerLocation !== null);

  return (
    <CustomerTypeContext.Provider
      value={{
        category,
        consumerTier,
        resellerLocation,
        companyData,
        consumerData,
        priceTable: getPriceTable(),
        setCategory: handleSetCategory,
        setConsumerTier,
        setResellerLocation,
        setCompanyData,
        setConsumerData,
        reset,
        isSelectionComplete,
      }}
    >
      {children}
    </CustomerTypeContext.Provider>
  );
}

export function useCustomerType() {
  const context = useContext(CustomerTypeContext);
  if (!context) {
    throw new Error('useCustomerType must be used within CustomerTypeProvider');
  }
  return context;
}
