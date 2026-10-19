import { build } from 'esbuild';

await build({
  entryPoints: ['src/content.ts', 'src/background.ts', 'src/page.ts'],
  bundle: true,
  outdir: 'dist',
  format: 'iife',
  target: 'chrome116',
  sourcemap: true,
  legalComments: 'none',
});
