import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

await build({
  entryPoints: ['src/content.ts', 'src/background.ts', 'src/page.ts'],
  bundle: true,
  outdir: 'dist',
  format: 'iife',
  target: 'chrome116',
  sourcemap: true,
  legalComments: 'none',
});

// Written only after every bundle is complete; the reload watcher ignores
// intermediate Vite/esbuild writes and keeps its debugging connection open.
await writeFile('dist/.build-ready', randomUUID());
