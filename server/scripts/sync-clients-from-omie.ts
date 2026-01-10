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
            
            if (existingCustomer) {
              // Atualizar cliente existente - NÃO sobrescrever weekdays/visitPeriodicity
              // IMPORTANTE: Preservar telefone editado manualmente se o existente for válido e Omie tiver 00000
              const isOmiePhoneEmpty = !converted.phone || converted.phone === '(00) 00000-0000' || converted.phone.includes('00000');
              const hasValidExistingPhone = existingCustomer.phone && 
                existingCustomer.phone !== '(00) 00000-0000' && 
                !existingCustomer.phone.includes('00000') &&
                existingCustomer.phone.length >= 10;
              
              // Só atualizar telefone se Omie tiver um válido, OU se o existente estiver vazio
              const shouldPreservePhone = hasValidExistingPhone && isOmiePhoneEmpty;
              
              await storage.updateCustomer(existingCustomer.id, {
                name: converted.name,
                customerType: converted.customerType,
                cpf: converted.cpf,
                cnpj: converted.cnpj,
                companyName: converted.companyName,
                fantasyName: converted.fantasyName,
                // ✅ PRESERVAR telefone editado manualmente se Omie não tiver válido
                phone: shouldPreservePhone ? existingCustomer.phone : converted.phone,
                email: converted.email,
                address: converted.address,
                city: converted.city,
                state: converted.state,
                zipCode: converted.zipCode,
                sellerId: converted.sellerId || existingCustomer.sellerId, // NUNCA sobrescrever com default
                isActive: converted.isActive,
                omieStatus: converted.omieStatus,
                situacao: converted.situacao,
                virtualService: false // IMPORTANTE: Garantir que não seja marcado como virtual
                // NÃO incluir weekdays/visitPeriodicity na atualização para preservar dados existentes
              });
              
              if (shouldPreservePhone) {
                console.log(`📞 [SYNC] Preservando telefone editado: ${existingCustomer.phone} para ${converted.name}`);
              }
              
              // Log quando atualizar vendedor
              if (converted.sellerId && converted.sellerId !== existingCustomer.sellerId) {
                console.log(`✅ Cliente ${converted.name}: vendedor atualizado para ${converted.sellerId}`);
              }
              
              result.updated++;
            } else {
              // Criar novo cliente - usar padrões seguros para weekdays/visitPeriodicity
              // Omie não fornece dados de agendamento, então usamos padrões do sistema
              const newClient = {
                ...converted,
                sellerId: finalSellerId,
                weekdays: JSON.stringify(["Dom"]), // Padrão: visitar aos domingos
                visitPeriodicity: 'semanal' as const, // Padrão: visita semanal
                virtualService: false // IMPORTANTE: Clientes sincronizados são presenciais por padrão
              };
              
              await storage.createCustomer(newClient);
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
