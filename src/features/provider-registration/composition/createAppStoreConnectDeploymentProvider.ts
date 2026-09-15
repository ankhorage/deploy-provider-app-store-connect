import type { DeploymentProviderRegistration } from '@ankhorage/contracts/deploy-provider';

import type { AppStoreConnectDeploymentProviderOptions } from '../../../types/appStoreConnect.js';
import { createAppStoreConnectRuntime } from '../../../utils/createAppStoreConnectRuntime.js';
import { createAppStoreConnectIosPublisher } from '../../ios-publication/adapters/outbound/createAppStoreConnectIosPublisher.js';
import { createAppStoreConnectMonetizationAdapter } from '../../monetization/adapters/outbound/createAppStoreConnectMonetizationAdapter.js';
import { createAppStoreConnectReleaseAdapter } from '../../release/adapters/outbound/createAppStoreConnectReleaseAdapter.js';
import { createAppStoreConnectSetupAdapter } from '../../setup/adapters/outbound/createAppStoreConnectSetupAdapter.js';
import { createAppStoreConnectStoreListingAdapter } from '../../store-listing/adapters/outbound/createAppStoreConnectStoreListingAdapter.js';

/***
 * Creates the canonical App Store Connect deployment provider registration.
 *
 * @readme `createAppStoreConnectDeploymentProvider` composes iOS publication, store listing,
 * monetization, release, and setup capabilities behind the portable deploy-provider contracts.
 */
export function createAppStoreConnectDeploymentProvider(
  options: AppStoreConnectDeploymentProviderOptions = {},
): DeploymentProviderRegistration {
  const runtime = createAppStoreConnectRuntime(options);
  return {
    descriptor: {
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
    },
    setup: createAppStoreConnectSetupAdapter(runtime),
    iosPublisher: createAppStoreConnectIosPublisher(runtime),
    storeListing: createAppStoreConnectStoreListingAdapter(runtime),
    monetization: createAppStoreConnectMonetizationAdapter(runtime),
    release: createAppStoreConnectReleaseAdapter(runtime),
  };
}
