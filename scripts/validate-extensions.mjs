#!/usr/bin/env node
import { validateAllEntries } from './extension-registry-lib.mjs';

const { results } = validateAllEntries();
const failures = results.filter((result) => result.errors.length);

for (const result of results) {
  if (!result.errors.length) {
    console.log(`ok ${result.id}`);
    continue;
  }
  console.error(`fail ${result.id}`);
  for (const error of result.errors) {
    console.error(`  - ${error}`);
  }
}

if (failures.length) {
  console.error(`\n${failures.length} extension entr${failures.length === 1 ? 'y' : 'ies'} failed validation.`);
  process.exit(1);
}

console.log(`validated ${results.length} extension entr${results.length === 1 ? 'y' : 'ies'}`);
