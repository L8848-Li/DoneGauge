import { build } from 'esbuild';

await build({
  entryPoints: ['src/adapters/dsh/card-view.tsx'],
  outfile: 'dist/src/adapters/dsh/client.js',
  bundle: true,
  format: 'cjs',
  // The DSH Web/desktop shell supplies the same React instance as its own cards.
  external: ['react', 'react/jsx-runtime'],
  banner: {
    js: 'window.__ModuleLoader__.load({id:"donegauge",factory:require=>{const module={exports:{}};const exports=module.exports;',
  },
  footer: { js: 'return module.exports;}});' },
});
