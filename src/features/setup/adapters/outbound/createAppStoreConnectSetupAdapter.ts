import type {
  DeploymentProviderSetupAdapter,
  DeploymentProviderSetupInspection,
} from '@ankhorage/contracts/deploy-provider';

import type { AppStoreConnectRuntime } from '../../../../utils/createAppStoreConnectRuntime.js';

/*** Creates App Store Connect setup inspection for iOS publication capabilities. */
export function createAppStoreConnectSetupAdapter(
  runtime: AppStoreConnectRuntime,
): DeploymentProviderSetupAdapter {
  return {
    provider: 'app-store-connect',
    inspectSetup: async (context) => {
      const access = await runtime.resolveTokenAsync(context.credentials, context.resolveSecret);
      return access.ok ? ready() : required(access.action);
    },
  };
}

/*** Creates the authenticated App Store Connect setup state. */
function ready(): DeploymentProviderSetupInspection {
  return {
    provider: 'app-store-connect',
    authentication: { status: 'authenticated' },
    capabilities: [{ capability: 'publish', status: 'available' }],
    provisioning: [],
  };
}

/*** Creates the setup state when App Store Connect authentication is missing. */
function required(
  action: Extract<
    Awaited<ReturnType<AppStoreConnectRuntime['resolveTokenAsync']>>,
    { readonly ok: false }
  >['action'],
): DeploymentProviderSetupInspection {
  return {
    provider: 'app-store-connect',
    authentication: { status: 'required', action },
    capabilities: [
      { capability: 'publish', status: 'unavailable', reason: 'Authentication required.' },
    ],
    provisioning: [{ type: 'authentication', action }],
  };
}
