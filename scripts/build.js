import { mkdir, copyFile, readFile, readdir } from 'node:fs/promises';
import { relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateData } from '../model.js';
import { validateVotingConfig } from '../polls.js';

// Copy only the deliberate public payload. data.json stays a separate runtime file.
const files = ['index.html', 'styles.css', 'app.js', 'model.js', 'polls.js', 'voting-config.json', 'data.json', '.nojekyll', 'assets/blue-dot.png', 'assets/green-dot.png', 'assets/yellow-dot.png', 'assets/pink-dot.png', 'assets/favicon.svg', 'assets/LICENSE.txt'];
validateData(JSON.parse(await readFile(new URL('../data.json', import.meta.url), 'utf8')));
validateVotingConfig(JSON.parse(await readFile(new URL('../voting-config.json', import.meta.url), 'utf8')), 'https://minutechreview.github.io/codex-28/');
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
const existing = await readdir(new URL('../dist/', import.meta.url), { recursive: true, withFileTypes: true });
const distRoot = fileURLToPath(new URL('../dist/', import.meta.url));
for (const item of existing) {
  const path = relative(distRoot, join(item.parentPath, item.name));
  if (item.isDirectory() && path === 'assets') continue;
  if (!item.isFile() || !files.includes(path)) throw new Error(`Unexpected item in dist: ${path}. Move it outside dist before publishing.`);
}
for (const file of files) {
  const target = new URL(`../dist/${file}`, import.meta.url);
  await mkdir(new URL('.', target), { recursive: true });
  await copyFile(new URL(`../${file}`, import.meta.url), target);
}
console.log(`Validated data and copied ${files.length} intended public files to dist/.`);
