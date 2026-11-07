import { defineConfig } from 'vite';

export default defineConfig(() => {
  const buildID = crypto.randomUUID();
  return {
    define: { __BUILD_ID__: JSON.stringify(buildID) },
    plugins: [{ name: 'build-identity', generateBundle() { this.emitFile({ type: 'asset', fileName: 'build-id.txt', source: buildID }); } }],
    build: {
      outDir: '../internal/webassets/dist',
      emptyOutDir: true,
    },
  };
});
