import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

const roots = ['.output/chrome-mv3'];
const forbidden = [
  /localStorage\.getItem\(["'](?:token|access_token|api_key)["']\)/i,
  /chrome\.cookies/i,
  /permissions["']?\s*:\s*\[[^\]]*["']cookies["']/i,
  /<all_urls>/i,
];
const textExtensions = new Set(['.css', '.html', '.js', '.json', '.map', '.txt']);

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(path)));
    else if (textExtensions.has(extname(entry.name))) files.push(path);
  }
  return files;
}

for (const root of roots) {
  const files = await collect(root);
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const pattern of forbidden) {
      if (pattern.test(source)) {
        throw new Error(`Forbidden security pattern ${pattern} found in ${file}`);
      }
    }
  }
}

console.log('Build security scan passed.');
