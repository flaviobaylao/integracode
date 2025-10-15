// Script temporário para testar endpoint de etapas
// Node.js 18+ tem fetch nativo

async function testEtapas() {
  try {
    // Login
    const loginResponse = await fetch('http://localhost:5000/api/auth/local-login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        username: 'flavio@bebahonest.com.br',
        password: 'M@riafe1'
      })
    });

    const cookies = loginResponse.headers.get('set-cookie');
    console.log('Login successful, cookies:', cookies);

    // Chamar endpoint de etapas
    const etapasResponse = await fetch('http://localhost:5000/api/omie/etapas-faturamento-count', {
      headers: {
        'Cookie': cookies
      }
    });

    const data = await etapasResponse.json();
    console.log('\n📊 RESULTADO DAS ETAPAS DE FATURAMENTO:\n');
    console.log(JSON.stringify(data, null, 2));

    if (data.etapas) {
      console.log('\n📋 RESUMO:\n');
      data.etapas.forEach(etapa => {
        console.log(`Etapa ${etapa.codigo} - ${etapa.nome}: ${etapa.totalNotas} notas fiscais`);
      });
    }
  } catch (error) {
    console.error('Erro:', error);
  }
}

testEtapas();
