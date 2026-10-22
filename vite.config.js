import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths, so the build also works when served from a
  // subpath such as https://<user>.github.io/polypainter/.
  base: './',
});
