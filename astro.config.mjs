import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
export default defineConfig({
  output: 'static',
  site: 'https://example.com',
  integrations: [sitemap()],
  vite: { ssr: { external: ['better-sqlite3'] } },
});
