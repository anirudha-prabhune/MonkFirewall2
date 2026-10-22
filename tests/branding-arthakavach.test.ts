import { strict as assert } from 'assert';
import fs from 'fs';
import path from 'path';

console.log('ARTHAKAVACH: BRANDING & MANIFEST V3 INTEGRITY SUITE');

// 1. Verify metadata.json
const metadataPath = path.resolve('./metadata.json');
assert.ok(fs.existsSync(metadataPath), 'metadata.json must exist');
const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
assert.ok(metadata.name.includes('ArthaKavach'), `metadata.json name must contain ArthaKavach, got: ${metadata.name}`);
console.log('  ✓ PASSED: metadata.json name is rebranded to ArthaKavach');

// 2. Verify index.html
const indexHtmlPath = path.resolve('./index.html');
assert.ok(fs.existsSync(indexHtmlPath), 'index.html must exist');
const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
assert.ok(indexHtml.includes('<title>ArthaKavach'), 'index.html <title> must include ArthaKavach');
assert.ok(indexHtml.includes('property="og:title" content="ArthaKavach'), 'index.html og:title must include ArthaKavach');
console.log('  ✓ PASSED: index.html title and OpenGraph metadata are rebranded to ArthaKavach');

// 3. Verify extension/manifest.json
const manifestPath = path.resolve('./extension/manifest.json');
assert.ok(fs.existsSync(manifestPath), 'extension/manifest.json must exist');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assert.equal(manifest.manifest_version, 3, 'manifest_version must be 3');
assert.ok(manifest.name.includes('ArthaKavach'), `extension/manifest.json name must contain ArthaKavach, got: ${manifest.name}`);
assert.ok(manifest.description.length > 10, 'extension/manifest.json must have descriptive copy');
assert.ok(manifest.permissions.includes('storage'), 'storage permission required');
assert.ok(manifest.permissions.includes('alarms'), 'alarms permission required');
assert.ok(manifest.permissions.includes('tabs'), 'tabs permission required');
assert.ok(manifest.permissions.includes('webNavigation'), 'webNavigation permission required');
console.log('  ✓ PASSED: extension/manifest.json is valid Manifest V3 with ArthaKavach name and permissions');

// 4. Verify extension/popup.html
const popupHtmlPath = path.resolve('./extension/popup.html');
assert.ok(fs.existsSync(popupHtmlPath), 'extension/popup.html must exist');
const popupHtml = fs.readFileSync(popupHtmlPath, 'utf8');
assert.ok(popupHtml.includes('ArthaKavach'), 'extension/popup.html must display ArthaKavach');
console.log('  ✓ PASSED: extension/popup.html displays ArthaKavach');

// 5. Verify extension/blocked.html and blocked.js
const blockedHtmlPath = path.resolve('./extension/blocked.html');
const blockedJsPath = path.resolve('./extension/blocked.js');
assert.ok(fs.existsSync(blockedHtmlPath), 'extension/blocked.html must exist');
assert.ok(fs.existsSync(blockedJsPath), 'extension/blocked.js must exist');
const blockedHtml = fs.readFileSync(blockedHtmlPath, 'utf8');
const blockedJs = fs.readFileSync(blockedJsPath, 'utf8');
assert.ok(blockedHtml.includes('ArthaKavach'), 'extension/blocked.html must reference ArthaKavach');
assert.ok(blockedJs.includes('ArthaKavach'), 'extension/blocked.js must reference ArthaKavach');
console.log('  ✓ PASSED: extension/blocked.html and blocked.js display ArthaKavach');

// 6. Verify Header.tsx and App.tsx
const headerPath = path.resolve('./src/components/Header.tsx');
const headerContent = fs.readFileSync(headerPath, 'utf8');
assert.ok(headerContent.includes('ArthaKavach'), 'Header.tsx must display ArthaKavach');

const appPath = path.resolve('./src/App.tsx');
const appContent = fs.readFileSync(appPath, 'utf8');
assert.ok(appContent.includes('ArthaKavach'), 'App.tsx must display ArthaKavach');
console.log('  ✓ PASSED: Header.tsx and App.tsx display ArthaKavach');

// 7. Verify internal identifiers and broker contracts are preserved for backwards compatibility
const bgPath = path.resolve('./extension/background.js');
const bgContent = fs.readFileSync(bgPath, 'utf8');
assert.ok(bgContent.includes('acc_mt_zerodha_default'), 'Internal Zerodha account ID acc_mt_zerodha_default preserved');
assert.ok(bgContent.includes('acc_mt_angelone_default'), 'Internal Angel One account ID acc_mt_angelone_default preserved');
console.log('  ✓ PASSED: Internal broker account identifiers preserved for backward compatibility');

console.log('\nALL ARTHAKAVACH BRANDING & MANIFEST V3 TESTS PASSED (7/7)');
