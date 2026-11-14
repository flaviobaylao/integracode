# INTEGRA Balcão v0.8.0 — vendedor obrigatório na venda

## O que muda na maquininha
- Botão **VENDEDOR** abaixo de VAREJO/ATACADO/Cliente (vermelho sem escolha, verde com o nome).
- **COBRAR sem vendedor abre a lista** ("Quem fez esta venda?") e só segue depois da escolha.
- Ao disparar a cobrança o vendedor é **esquecido**: a próxima venda pede de novo.
- O vendedor vai no `POST /api/lio-app/venda` (`vendedorId`), sai no comprovante ("Vendedor") e o pedido
  de venda (sales_card) nasce com `seller_id` dele → conta no resultado do vendedor.
- Lista vem de `GET /api/lio-app/vendedores` (usuários ativos com papel vendedor/telemarketing).

## Servidor
PR #226 mesclado em 07/11/2026 (server/lio-pdv.ts). Compatível com o app 0.7.0.

## Arquivos
- `integra-balcao-v0.8.0.apk` — assinado com o certificado de sempre (SHA-256 13:d4:17:a8…b9:6d…), só v2,
  versionCode 9. Instala por cima da 0.7.0 sem perder o pareamento.
- `integra-balcao-src-v0.8.0.zip` — **código-fonte completo** (Kotlin, reconstruído a partir do APK 0.7.0 +
  a mudança do vendedor). Guarde: a fonte da 0.7.0 tinha se perdido.

## Como instalar na L400
Mesmo caminho da 0.7.0: APK publicado em `apk/` no repo (raw.githubusercontent) → QR Code → instalar.

## Como compilar de novo (Linux/Windows)
JDK 17+, Android SDK (platform 34, build-tools 34.0.0), Gradle 8.7:
```
gradle assembleRelease
zipalign -f -p 4 app/build/outputs/apk/release/app-release-unsigned.apk aligned.apk
apksigner sign --ks debug.keystore --ks-pass pass:android --ks-key-alias androiddebugkey \
  --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled false --out saida.apk aligned.apk
```
