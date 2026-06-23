#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildRegistry } from './extension-registry-lib.mjs';

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

const out = argValue('--out') || 'registry.json';
const registry = buildRegistry();
const payload = `${JSON.stringify(registry, null, 2)}\n`;

mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
writeFileSync(out, payload, 'utf8');

console.log(`wrote ${out} with ${registry.extensions.length} extension entr${registry.extensions.length === 1 ? 'y' : 'ies'}`);
