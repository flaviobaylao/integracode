import { OmieService } from '../omieIntegration';
import { storage } from '../storage';

async function syncClientsFromOmie() {
  try {
    console.log('🔄 Iniciando sincronização de clientes do Omie...\n');

    const omieService = OmieService.createFromEnv(storage);
    const defaultSellerId = 'admin-flavio';

    const result = {
      totalProcessed: 0,
      imported: 0,
      updated: 0,
      errors: [] as string[]
    };

    let currentPage = 1;
    let hasMorePages = true;

    while (hasMorePages) {
      console.log(`📄 Processando página ${currentPage}...`);

      try {
        const pageData = await omieService.getAllClients(currentPage, 100, false);
        const allClients = pageData.clients || [];

        // Filtrar apenas clientes ativos
        const activeClients = allClients.filter(client => {
          if (client.situacao) {
            return client.situacao === 'ativo';
          }
          return client.inativo !== 'S';
        });

        console.log(`   → ${allClients.length} clientes total, ${activeClients.length} ativos na página ${currentPage}`);

        if (allClients.length === 0) {
          console.log('✅ Nenhum cliente na página, finalizando');
          break;
        }

        for (const omieClient of activeClients) {
          result.totalProcessed++;

          if (result.totalProcessed % 100 === 0) {
            console.log(`⏳ ${result.totalProcessed} clientes processados...`);
          }

          try {
            // Converter cliente do Omie
            const converted = omieService.convertClientToSystemFormat(omieClient);
            
            // Verificar se cliente já existe ANTES de definir sellerId
            const existingCustomer = await storage.getCustomer(converted.id);

            // Prioridade de vendedor: Omie > Existente > Default (NUNCA sobrescrever vendedor existente com default)
            const finalSellerId = converted.sellerId || existingCustomer?.sellerId || defaultSellerId || '';
            
            const systemClient = {
              ...converted,
              sellerId: finalSellerId,
              weekdays: "segunda,terça,quarta,quinta,sexta",
              virtualService: false // IMPORTANTE: Clientes sincronizados são presenciais por padrão
            };

            if (existingCustomer) {
              // Atualizar cliente existente
              await storage.updateCustomer(existingCustomer.id, {
                name: systemClient.name,
                customerType: systemClient.customerType,
                cpf: systemClient.cpf,
                cnpj: systemClient.cnpj,
                companyName: systemClient.companyName,
                fantasyName: systemClient.fantasyName,
                phone: systemClient.phone,
                email: systemClient.email,
                address: systemClient.address,
                city: systemClient.city,
                state: systemClient.state,
                zipCode: systemClient.zipCode,
                sellerId: converted.sellerId || existingCustomer.sellerId, // NUNCA sobrescrever com default
                isActive: systemClient.isActive,
                omieStatus: systemClient.omieStatus,
                situacao: systemClient.situacao,
                virtualService: false // IMPORTANTE: Garantir que não seja marcado como virtual
              });
              
              // Log quando atualizar vendedor
              if (systemClient.sellerId && systemClient.sellerId !== existingCustomer.sellerId) {
                console.log(`✅ Cliente ${systemClient.name}: vendedor atualizado para ${systemClient.sellerId}`);
              }
              
              result.updated++;
            } else {
              // Criar novo cliente
              await storage.createCustomer(systemClient);
              result.imported++;
            }

          } catch (clientError: any) {
            const errorMsg = clientError instanceof Error ? clientError.message : 'Erro desconhecido';
            console.error(`❌ Erro cliente ${omieClient.codigo_cliente_omie}:`, errorMsg);
            result.errors.push(`Cliente ${omieClient.razao_social}: ${errorMsg}`);
          }
        }

        // Próxima página
        currentPage++;
        hasMorePages = currentPage <= pageData.totalPages;

      } catch (pageError: any) {
        console.error(`❌ Erro na página ${currentPage}:`, pageError);
        result.errors.push(`Erro na página ${currentPage}: ${pageError instanceof Error ? pageError.message : 'Erro desconhecido'}`);
        break;
      }
    }

    console.log(`\n✅ Sincronização concluída:`);
    console.log(`   - Total processado: ${result.totalProcessed}`);
    console.log(`   - Novos clientes: ${result.imported}`);
    console.log(`   - Clientes atualizados: ${result.updated}`);
    console.log(`   - Erros: ${result.errors.length}`);

    if (result.errors.length > 0) {
      console.log('\n❌ Erros encontrados:');
      result.errors.slice(0, 10).forEach(err => console.log(`   - ${err}`));
      if (result.errors.length > 10) {
        console.log(`   ... e mais ${result.errors.length - 10} erros`);
      }
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ Erro:', error);
    process.exit(1);
  }
}

syncClientsFromOmie();
