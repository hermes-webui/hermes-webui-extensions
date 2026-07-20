#!/usr/bin/env node
import { REPO_ROOT, validateAllEntries } from './extension-registry-lib.mjs';
import { checkScaffoldSync, checkSidecarUsage } from './sidecar-contract-lib.mjs';

const { results } = validateAllEntries();
const failures = results.filter((result) => result.errors.length);
const sidecarUsage = checkSidecarUsage(REPO_ROOT);
const sidecarFailures = [
  ...checkScaffoldSync(REPO_ROOT).failures,
  ...sidecarUsage.failures
];

for (const result of results) {
  if (!result.errors.length) {
    console.log(`ok ${result.id}`);
    for (const warning of result.warnings || []) console.warn(`  warning: ${warning}`);
    continue;
  }
  console.error(`fail ${result.id}`);
  for (const error of result.errors) {
    console.error(`  - ${error}`);
  }
}

for (const warning of sidecarUsage.warnings) console.warn(`warning: ${warning}`);

if (sidecarFailures.length) {
  console.error('fail sidecar contract');
  for (const error of sidecarFailures) console.error(`  - ${error}`);
}

if (failures.length || sidecarFailures.length) {
  console.error(
    `\n${failures.length} extension entr${failures.length === 1 ? 'y' : 'ies'} and `
    + `${sidecarFailures.length} sidecar contract check${sidecarFailures.length === 1 ? '' : 's'} failed validation.`
  );
  process.exit(1);
}

console.log(`validated ${results.length} extension entr${results.length === 1 ? 'y' : 'ies'}`);
