import type {
  DeploymentMonetizationAdapter,
  DeploymentProviderResult,
  MonetizationAdapterContext,
  MonetizationSyncRequest,
  MonetizationTargetState,
} from '@ankhorage/contracts/deploy-provider';

import type { AppStoreConnectRuntime } from '../../../../utils/createAppStoreConnectRuntime.js';
import { findAppStoreConnectAppIdAsync } from '../../../../utils/findAppStoreConnectAppIdAsync.js';
import { inspectAppStoreConnectMonetizationAsync } from './inspectAppStoreConnectMonetizationAsync.js';
import { syncAppStoreConnectMonetizationProductAsync } from './syncAppStoreConnectMonetizationProductAsync.js';

/*** Creates the App Store Connect monetization adapter for IAPs and subscriptions. */
export function createAppStoreConnectMonetizationAdapter(
  runtime: AppStoreConnectRuntime,
): DeploymentMonetizationAdapter {
  return {
    target: 'ios',
    inspectAsync: (context) => inspectAsync(context, runtime),
    syncAsync: (request) => syncAsync(request, runtime),
  };
}

/*** Inspects portable monetization state for the configured App Store app. */
async function inspectAsync(
  context: MonetizationAdapterContext,
  runtime: AppStoreConnectRuntime,
): Promise<DeploymentProviderResult<MonetizationTargetState>> {
  if (context.identity.target !== 'ios') return failed('APP_STORE_MONETIZATION_IDENTITY_INVALID');
  const access = await runtime.resolveTokenAsync(context.credentials, context.resolveSecret);
  if (!access.ok) return { status: 'action-required', action: access.action };
  const appId = await findAppStoreConnectAppIdAsync(
    context.identity.bundleIdentifier,
    access.token,
    runtime,
  );
  if (appId === null) return appRequired();
  const state = await inspectAppStoreConnectMonetizationAsync({
    appId,
    token: access.token,
    runtime,
  });
  return state === null
    ? failed('APP_STORE_MONETIZATION_INSPECTION_FAILED')
    : { status: 'completed', value: state };
}

/*** Executes provider-owned monetization plan steps and re-inspects the resulting state. */
async function syncAsync(
  request: MonetizationSyncRequest,
  runtime: AppStoreConnectRuntime,
): Promise<DeploymentProviderResult<MonetizationTargetState>> {
  if (request.identity.target !== 'ios') return failed('APP_STORE_MONETIZATION_IDENTITY_INVALID');
  if (request.plan.status === 'blocked') return failed('APP_STORE_MONETIZATION_PLAN_BLOCKED');
  if (request.plan.status === 'no-change') return inspectAsync(request, runtime);
  const access = await runtime.resolveTokenAsync(request.credentials, request.resolveSecret);
  if (!access.ok) return { status: 'action-required', action: access.action };
  const appId = await findAppStoreConnectAppIdAsync(
    request.identity.bundleIdentifier,
    access.token,
    runtime,
  );
  if (appId === null) return appRequired();
  for (const step of request.plan.steps) {
    if (step.target !== 'ios') continue;
    const product = request.desired.products.find((value) => value.id === step.productId);
    if (product === undefined) return failed('APP_STORE_MONETIZATION_PRODUCT_MISSING');
    const synced = await syncAppStoreConnectMonetizationProductAsync({
      appId,
      product,
      token: access.token,
      runtime,
    });
    if (!synced) return failed('APP_STORE_MONETIZATION_SYNC_FAILED');
  }
  return inspectAsync(request, runtime);
}

/*** Creates the manual action required when the App Store app is absent. */
function appRequired(): DeploymentProviderResult<MonetizationTargetState> {
  return {
    status: 'action-required',
    action: {
      type: 'manual-action',
      target: 'ios',
      provider: 'app-store-connect',
      code: 'APP_STORE_APP_REQUIRED',
      message: 'Create the matching app in App Store Connect before monetization synchronization.',
    },
  };
}

/*** Creates a failed App Store monetization result. */
function failed(code: string): DeploymentProviderResult<MonetizationTargetState> {
  return {
    status: 'failed',
    failure: {
      code,
      message: 'App Store Connect monetization operation failed.',
      target: 'ios',
      provider: 'app-store-connect',
    },
  };
}
