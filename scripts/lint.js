const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = process.cwd();
const TARGET_DIRS = ['src', 'scripts', 'test'];

function listJsFiles(startDir) {
  if (!fs.existsSync(startDir)) return [];

  const out = [];
  const entries = fs.readdirSync(startDir, { withFileTypes: true });

  for (const entry of entries) {
    const full = path.join(startDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listJsFiles(full));
      continue;
    }
    if (entry.isFile() && full.endsWith('.js')) {
      out.push(full);
    }
  }

  return out;
}

const files = TARGET_DIRS.flatMap((dir) => listJsFiles(path.join(ROOT, dir)));
if (files.length === 0) {
  console.log('[lint] Nenhum arquivo .js encontrado nos diretorios alvo.');
  process.exit(0);
}

let failed = 0;
for (const file of files) {
  const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (check.status !== 0) {
    failed += 1;
    console.error(`\n[lint] Erro de sintaxe em: ${path.relative(ROOT, file)}`);
    if (check.stderr) console.error(check.stderr.trim());
  }
}

if (failed > 0) {
  console.error(`\n[lint] Falhou: ${failed} arquivo(s) com erro de sintaxe.`);
  process.exit(1);
}

console.log(`[lint] OK: ${files.length} arquivo(s) verificados.`);
