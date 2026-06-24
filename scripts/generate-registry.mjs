#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_REGISTRY_BASE_URL, buildRegistryWithArtifacts } from './extension-registry-lib.mjs';

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

const out = argValue('--out') || 'registry.json';
const artifactBaseUrl = argValue('--base-url') || process.env.HERMES_EXTENSION_REGISTRY_BASE_URL || DEFAULT_REGISTRY_BASE_URL;
const outPath = path.resolve(out);
const outDir = path.dirname(outPath);
const artifactsDir = path.join(outDir, 'artifacts');
const { registry, artifacts } = buildRegistryWithArtifacts({ artifactBaseUrl });
const payload = `${JSON.stringify(registry, null, 2)}\n`;

mkdirSync(outDir, { recursive: true });
mkdirSync(artifactsDir, { recursive: true });
writeFileSync(outPath, payload, 'utf8');
for (const artifact of artifacts) {
  writeFileSync(path.join(artifactsDir, artifact.name), artifact.buffer);
}

console.log(`wrote ${out} with ${registry.extensions.length} extension entr${registry.extensions.length === 1 ? 'y' : 'ies'}`);
console.log(`wrote ${artifacts.length} extension artifact${artifacts.length === 1 ? '' : 's'} to ${path.relative(process.cwd(), artifactsDir) || artifactsDir}`);
