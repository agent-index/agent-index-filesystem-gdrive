// scripts/build.js — Adapter build pipeline
// Bundles the MCP server, computes checksum, and stamps adapter.json.
// Run via: npm run build

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Step 1: Bundle with esbuild
console.log('Bundling...');
execSync('npm run build:bundle', { stdio: 'inherit' });

// Step 2: Compute checksum of the built bundle
const bundle = readFileSync('dist/server.bundle.js');
const hash = createHash('sha256').update(bundle).digest('hex');
const checksum = `sha256:${hash}`;
console.log(`Bundle checksum: ${checksum}`);
console.log(`Bundle size: ${(bundle.length / 1024 / 1024).toFixed(2)} MB`);

// Step 3: Stamp adapter.json with build metadata
const adapter = JSON.parse(readFileSync('adapter.json', 'utf8'));
adapter.bundle_built_at = new Date().toISOString();
adapter.bundle_checksum = checksum;
writeFileSync('adapter.json', JSON.stringify(adapter, null, 2) + '\n');

console.log(`adapter.json updated — version: ${adapter.version}, built: ${adapter.bundle_built_at}`);
console.log('Build complete. Commit dist/server.bundle.js and adapter.json together.');
