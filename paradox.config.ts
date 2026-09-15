import { defineParadoxConfig } from '@ankhorage/paradox';

export default defineParadoxConfig({
  mode: 'write',
  docs: {
    title: '@ankhorage/deploy-provider-app-store-connect',
    description: 'App Store Connect deployment provider for Ankhorage application shipment.',
  },
  package: {
    root: '.',
    entrypoints: ['src/deployProviderAppStoreConnect.ts'],
  },
  output: { dir: './paradox' },
});
