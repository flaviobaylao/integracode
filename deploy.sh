#!/bin/bash
set -e

echo "🔨 FORÇANDO REBUILD COMPLETO..."

# Limpar cache e builds anteriores
echo "🧹 Limpando cache..."
rm -rf dist/
rm -rf node_modules/.vite/
rm -rf .vite/

# Rebuild frontend e backend
echo "📦 Reconstruindo aplicação..."
npm run build

# Verificar se dist/index.js foi gerado
if [ -f "dist/index.js" ]; then
  echo "✅ dist/index.js gerado com sucesso!"
  
  # Verificar se contém a correção SQL
  if grep -q "'omie-client-' ||" dist/index.js; then
    echo "✅ Correção SQL encontrada no build!"
  else
    echo "❌ ERRO: Correção SQL NÃO encontrada no build!"
    exit 1
  fi
  
  # Verificar se contém o marcador de versão
  if grep -q "20251124_203644_SQL_FIX" dist/index.js; then
    echo "✅ Marcador de versão encontrado no build!"
  else
    echo "⚠️  AVISO: Marcador de versão NÃO encontrado no build!"
  fi
else
  echo "❌ ERRO: dist/index.js NÃO foi gerado!"
  exit 1
fi

echo ""
echo "✅ BUILD COMPLETO E VALIDADO!"
echo "🚀 Agora faça o REPUBLISH no painel Publishing"
echo ""
