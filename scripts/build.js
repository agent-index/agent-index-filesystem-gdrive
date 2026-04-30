// scripts/build.js — Adapter build pipeline
// Bundles the on-demand executor, copies the shell wrapper,
// computes checksums, and stamps adapter.json.
// Run via: npm run build

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

function checksum(filePath) {
  const data = readFileSync(filePath);
  const hash = createHash('sha256').update(data).digest('hex');
  return { hash: `sha256:${hash}`, size: data.length };
}

// Step 1: Bundle on-demand executor
console.log('Bundling on-demand executor...');
execSync('npm run build:exec', { stdio: 'inherit' });

const exec = checksum('dist/aifs-exec.bundle.js');
console.log(`  aifs-exec.bundle.js: ${exec.hash} (${(exec.size / 1024 / 1024).toFixed(2)} MB)`);

// Step 2: Copy shell wrapper to dist
copyFileSync('src/aifs-exec.sh', 'dist/aifs-exec.sh');
console.log('  aifs-exec.sh copied to dist/');

// Step 3: Stamp adapter.json with build metadata
const adapter = JSON.parse(readFileSync('adapter.json', 'utf8'));
adapter.bundle_built_at = new Date().toISOString();
adapter.exec_bundle_checksum = exec.hash;
writeFileSync('adapter.json', JSON.stringify(adapter, null, 2) + '\n');

console.log(`adapter.json updated — version: ${adapter.version}, built: ${adapter.bundle_built_at}`);
console.log('Build complete. Commit dist/ and adapter.json together.');
