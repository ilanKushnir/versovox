import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Injects the app-shell precache manifest into the built service worker.
 * After the bundle is written, every hashed JS/CSS asset plus local fonts
 * and icons is enumerated and spliced into dist/sw.js, replacing the
 * /*__VX_PRECACHE__* / and /*__VX_BUILD__* / placeholders. The BUILD id is a
 * content hash so the shell cache rotates exactly when the shell changes.
 */
function swPrecachePlugin(): Plugin {
  return {
    name: 'vx-sw-precache',
    apply: 'build',
    closeBundle() {
      const dist = path.resolve(__dirname, 'dist');
      const swPath = path.join(dist, 'sw.js');
      if (!fs.existsSync(swPath)) return;
      const urls = new Set<string>(['/', '/manifest.webmanifest']);
      const walk = (dir: string, base: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const rel = `${base}/${e.name}`;
          if (e.isDirectory()) walk(path.join(dir, e.name), rel);
          else if (e.isFile() && !e.name.endsWith('.map')) urls.add(rel);
        }
      };
      for (const sub of ['assets', 'fonts', 'icons']) {
        const dir = path.join(dist, sub);
        if (fs.existsSync(dir)) walk(dir, `/${sub}`);
      }
      urls.add('/sw-range.js');
      urls.add('/sw-auth.js');
      const list = [...urls].sort();
      const hash = createHash('sha256');
      for (const u of list) {
        hash.update(u);
        const file = path.join(dist, u === '/' ? 'index.html' : u.slice(1));
        if (fs.existsSync(file) && fs.statSync(file).isFile()) hash.update(fs.readFileSync(file));
      }
      const build = hash.digest('hex').slice(0, 12);
      let sw = fs.readFileSync(swPath, 'utf8');
      sw = sw.replace(/\/\*__VX_BUILD__\*\/\s*'dev'/, `'${build}'`);
      sw = sw.replace(
        /const PRECACHE = \/\*__VX_PRECACHE__\*\/ \[[^\]]*\];/,
        `const PRECACHE = ${JSON.stringify(list)};`,
      );
      fs.writeFileSync(swPath, sw);
    },
  };
}

export default defineConfig({
  plugins: [react(), swPrecachePlugin()],
  server: {
    port: 5183,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8383', changeOrigin: false },
    },
  },
  build: {
    sourcemap: true,
    assetsInlineLimit: 0,
  },
});
