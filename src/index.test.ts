import { describe, expect, it } from 'bun:test';

import { createAppStoreConnectDeploymentProvider } from './index.js';

const apiKey = JSON.stringify({
  keyId: 'KEY123',
  issuerId: 'issuer',
  privateKey: 'private-key',
});
const createToken = () => Promise.resolve('token');
const resolveSecret = () => Promise.resolve(apiKey);

describe('createAppStoreConnectDeploymentProvider', () => {
  it('registers every App Store Connect deployment capability', () => {
    const provider = createAppStoreConnectDeploymentProvider({ createToken });

    expect(provider.descriptor).toEqual({
      id: 'app-store-connect',
      packageName: '@ankhorage/deploy-provider-app-store-connect',
      displayName: 'App Store Connect',
      capabilities: [
        { id: 'setup', targets: ['ios'] },
        { id: 'ios-publish', targets: ['ios'] },
        { id: 'store-listing', targets: ['ios'] },
        { id: 'monetization', targets: ['ios'] },
        { id: 'release', targets: ['ios'] },
      ],
    });
    expect(provider.setup).toBeDefined();
    expect(provider.iosPublisher).toBeDefined();
    expect(provider.storeListing).toBeDefined();
    expect(provider.monetization).toBeDefined();
    expect(provider.release).toBeDefined();
    expect(provider.iosBuilder).toBeUndefined();
  });

  it('reports missing API-key authentication through setup', async () => {
    const provider = createAppStoreConnectDeploymentProvider({ createToken });
    const inspection = await provider.setup?.inspectSetup({
      projectRoot: '/app',
      target: 'ios',
      credentials: [],
      resolveSecret: () => Promise.resolve(null),
    });

    expect(inspection?.authentication.status).toBe('required');
    expect(inspection?.provisioning).toHaveLength(1);
  });

  it('normalizes iOS version and build inspection through the public publisher port', async () => {
    const provider = createAppStoreConnectDeploymentProvider({
      createToken,
      request: (request) => {
        if (request.url.includes('/apps?')) {
          return Promise.resolve({
            status: 200,
            body: JSON.stringify({
              data: [
                {
                  type: 'apps',
                  id: 'app-id',
                  attributes: { bundleId: 'com.example.app' },
                },
              ],
            }),
          });
        }
        return Promise.resolve({
          status: 200,
          body: JSON.stringify({
            data: [
              {
                type: 'appStoreVersions',
                id: 'version-id',
                attributes: { platform: 'IOS', versionString: '1.2.3' },
                relationships: { build: { data: { type: 'builds', id: 'build-id' } } },
              },
            ],
            included: [
              {
                type: 'builds',
                id: 'build-id',
                attributes: { version: '42', processingState: 'VALID' },
              },
            ],
          }),
        });
      },
    });
    const inspection = await provider.iosPublisher?.inspectAsync({
      bundleIdentifier: 'com.example.app',
      version: '1.2.3',
      credentials: [{ provider: 'app-store-connect', id: 'apple', kind: 'api-key' }],
      resolveSecret,
    });

    expect(inspection).toEqual({
      status: 'completed',
      value: { bundleIdentifier: 'com.example.app', version: '1.2.3', buildNumber: '42' },
    });
  });
});
