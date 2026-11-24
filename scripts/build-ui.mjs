import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
fs.mkdirSync(distDir, { recursive: true });

// Trim Excalidraw's ~5 MiB of unused optional dynamic chunks (50+ unused locales and its internal Mermaid modal,
// since Mermaid import is handled server-side via ELK.js). Keeps English + Simplified Chinese locales intact.
const trimExcalidrawPlugin = {
  name: 'trim-excalidraw-bloat',
  setup(build) {
    build.onResolve({ filter: /locales\/.*\.js$/ }, (args) => {
      if (/(?:^|[\\/])(en|zh-CN)[.-]/.test(args.path)) return null;
      return { path: args.path, namespace: 'empty-locale' };
    });
    build.onLoad({ filter: /.*/, namespace: 'empty-locale' }, () => ({
      contents: 'export default {};',
      loader: 'js',
    }));
    build.onResolve({ filter: /^(@excalidraw\/mermaid-to-excalidraw|mermaid|cytoscape|katex)$/ }, (args) => ({
      path: args.path,
      namespace: 'stub-optional',
    }));
    build.onLoad({ filter: /.*/, namespace: 'stub-optional' }, () => ({
      contents: 'export default {}; export const parseMermaidToExcalidraw = async () => { throw new Error("Use the import_mermaid MCP tool."); };',
      loader: 'js',
    }));
  },
};

const result = await esbuild.build({
  entryPoints: [path.join(rootDir, 'src/ui/main.tsx')],
  bundle: true,
  minify: true,
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  conditions: ['production'],
  write: false,
  outdir: distDir,
  plugins: [trimExcalidrawPlugin],
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env.IS_PREACT': '"false"',
  },
  loader: {
    '.woff2': 'dataurl',
    '.woff': 'dataurl',
    '.ttf': 'dataurl',
    '.png': 'dataurl',
    '.svg': 'dataurl',
  },
});

const jsFile = result.outputFiles.find((f) => f.path.endsWith('.js'));
const cssFile = result.outputFiles.find((f) => f.path.endsWith('.css'));

if (!jsFile) {
  throw new Error('esbuild did not produce a JS bundle');
}

const cssContent = cssFile ? cssFile.text.replace(/<\/style>/gi, '<\\/style>') : '';
const jsContent = jsFile.text.replace(/<\/script>/gi, '<\\/script>');

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Antigravity Whiteboard</title>
    <script>window.EXCALIDRAW_ASSET_PATH = [];</script>
    <style>${cssContent}</style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">${jsContent}</script>
  </body>
</html>
`;

const outPath = path.join(distDir, 'index.html');
fs.writeFileSync(outPath, html, 'utf8');
const sizeMB = Buffer.byteLength(html, 'utf8') / (1024 * 1024);
console.log(`Built dist/index.html (${sizeMB.toFixed(2)} MiB)`);
if (sizeMB >= 9.5) {
  console.warn(`WARNING: dist/index.html is close to the 10 MiB MCP App limit!`);
}
