import { copyFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const projectRoot = resolve(__dirname, '..');
const source = join(projectRoot, 'attached_assets');
const dest = join(projectRoot, 'dist/public/attached_assets');

function copyDir(src, dst) {
  if (!existsSync(src)) {
    console.log(`⚠️  Source não existe: ${src}`);
    return;
  }

  mkdirSync(dst, { recursive: true });
  console.log(`📁 Criado diretório: ${dst}`);

  const entries = readdirSync(src);

  for (const entry of entries) {
    const srcPath = join(src, entry);
    const dstPath = join(dst, entry);

    if (statSync(srcPath).isDirectory()) {
      copyDir(srcPath, dstPath);
    } else {
      copyFileSync(srcPath, dstPath);
      console.log(`✅ Copiado: ${entry}`);
    }
  }
}

console.log('🚀 Copiando attached_assets para dist/public...');
copyDir(source, dest);
console.log('✨ Cópia concluída!');
