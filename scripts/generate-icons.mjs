import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const source = fileURLToPath(new URL('../assets/icon.svg', import.meta.url));
const outputDirectory = new URL('../public/icon/', import.meta.url);
const sizes = [16, 32, 48, 128];

await mkdir(outputDirectory, { recursive: true });
await Promise.all(
  sizes.map((size) =>
    sharp(source)
      .resize(size, size)
      .png({ compressionLevel: 9, palette: true })
      .toFile(fileURLToPath(new URL(`${size}.png`, outputDirectory))),
  ),
);

console.log(`Generated ${sizes.length} packaged extension icons.`);
