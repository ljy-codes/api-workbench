import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const packageJson = JSON.parse(read('package.json'));
const packageLock = JSON.parse(read('package-lock.json'));
const tauriConfig = JSON.parse(read('src-tauri/tauri.conf.json'));
const cargoToml = read('src-tauri/Cargo.toml');
const cargoLock = read('src-tauri/Cargo.lock');

const version = packageJson.version;
const cargoVersion = cargoToml.match(/^name = "api-workbench"\s*\nversion = "([^"]+)"/m)?.[1];
const cargoLockVersion = cargoLock.match(/\[\[package\]\]\s*\nname = "api-workbench"\s*\nversion = "([^"]+)"/m)?.[1];
const values = [
  ['package.json', version],
  ['package-lock.json', packageLock.version],
  ['package-lock.json packages[""].version', packageLock.packages?.['']?.version],
  ['src-tauri/tauri.conf.json', tauriConfig.version],
  ['src-tauri/Cargo.toml', cargoVersion],
  ['src-tauri/Cargo.lock', cargoLockVersion],
];

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Invalid package version: ${version ?? '<missing>'}`);
  process.exit(1);
}

const mismatches = values.filter(([, value]) => value !== version);
if (mismatches.length) {
  console.error(`Version metadata mismatch; expected ${version}:`);
  for (const [name, value] of mismatches) console.error(`- ${name}: ${value ?? '<missing>'}`);
  process.exit(1);
}

console.log(`Version metadata OK: ${version}`);
