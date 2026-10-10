import { mkdir, copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validateVersusData } from '../versus-model.js';
import { validateVersusConfig } from '../versus-poll.js';
import { createShareMetadata, escapeHtml } from './generate-versus-share.js';

// Explicit redesigned payload. The independent legacy poll and backend stay outside dist.
const files = ['index.html','versus.css','versus-app.js','versus-model.js','versus-poll.js','model.js','versus-config.json','data.json','versus.json','.nojekyll','assets/tibo.jpg','assets/poteto.jpg','assets/versus-favicon.svg','assets/versus-share.png','assets/versus-share-metadata.json','assets/PressStart2P-Regular.ttf','assets/FONT-LICENSE.txt','assets/LICENSE.txt','docs/versus-rules.md'];
const [trackerBytes, versusBytes] = await Promise.all([readFile(new URL('../data.json',import.meta.url)),readFile(new URL('../versus.json',import.meta.url))]);
const data = validateVersusData(JSON.parse(trackerBytes), JSON.parse(versusBytes));
validateVersusConfig(JSON.parse(await readFile(new URL('../versus-config.json',import.meta.url),'utf8')), 'https://minutechreview.github.io/codex-28/');
const imageMetadata = JSON.parse(await readFile(new URL('../assets/versus-share-metadata.json',import.meta.url),'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const [file,bytes] of [['data.json',trackerBytes],['versus.json',versusBytes]]) {
  if (imageMetadata.hashes?.[file] !== hash(bytes)) throw new Error(`Share image is stale for ${file}. Run npm run share:generate.`);
}
const metadata = createShareMetadata(data,imageMetadata.hashes);
if (metadata.imageAlt !== imageMetadata.imageAlt) throw new Error('Share counters changed. Run npm run share:generate.');
await mkdir(new URL('../dist/',import.meta.url),{recursive:true});
const root = fileURLToPath(new URL('../dist/',import.meta.url));
for (const item of await readdir(root,{recursive:true,withFileTypes:true})) {
  const path = relative(root,join(item.parentPath,item.name));
  if (item.isDirectory() && ['assets','docs'].includes(path)) continue;
  if (!item.isFile() || !files.includes(path)) throw new Error(`Unexpected item in dist: ${path}. Preserve it outside the reviewed build before continuing.`);
}
for (const file of files) {
  const target = new URL(`../dist/${file}`,import.meta.url);
  await mkdir(new URL('.',target),{recursive:true});
  await copyFile(new URL(`../${file}`,import.meta.url),target);
}
let html = await readFile(new URL('../dist/index.html',import.meta.url),'utf8');
for (const [property,value] of [['og:title',metadata.title],['og:description',metadata.description],['og:image',metadata.imageUrl],['og:image:alt',metadata.imageAlt]]) {
  const tag = `<meta property="${property}" content="${escapeHtml(value)}">`;
  html = html.replace(new RegExp(`<meta property="${property}" content="[^"]*">`),tag);
}
await writeFile(new URL('../dist/index.html',import.meta.url),html);
if (hash(await readFile(new URL('../data.json',import.meta.url))) !== hash(trackerBytes)) throw new Error('data.json changed during build.');
if (hash(await readFile(new URL('../dist/data.json',import.meta.url))) !== hash(trackerBytes)) throw new Error('Build data bytes differ.');
console.log(`Validated both data sources, verified share hashes, copied ${files.length} public files; data.json byte-identical.`);
