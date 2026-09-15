import type {
  DeploymentProviderResult,
  DeploymentStoreListingAdapter,
  StoreListingAdapterContext,
  StoreListingSyncRequest,
  StoreListingTargetState,
} from '@ankhorage/contracts/deploy-provider';

import type { AppStoreConnectRuntime } from '../../../../utils/createAppStoreConnectRuntime.js';
import { createAppStoreConnectListingMetadataApi } from './appStoreConnectListingMetadataApi.js';
import { createAppStoreConnectScreenshotApi } from './appStoreConnectScreenshotApi.js';
import { mergeAppStoreListingLocales } from './mergeAppStoreListingLocales.js';

const SUPPORTED_FIELDS = [
  'name',
  'summary',
  'description',
  'keywords',
  'promotionalText',
  'supportUrl',
  'marketingUrl',
  'privacyPolicyUrl',
] as const;

/*** Creates the App Store listing adapter for localized metadata and screenshots. */
export function createAppStoreConnectStoreListingAdapter(
  runtime: AppStoreConnectRuntime,
): DeploymentStoreListingAdapter {
  const metadata = createAppStoreConnectListingMetadataApi(runtime);
  const screenshots = createAppStoreConnectScreenshotApi(runtime);
  return {
    target: 'ios',
    inspectAsync: (context) => inspectAsync(context, runtime, metadata, screenshots),
    syncAsync: (request) => syncAsync(request, runtime, metadata, screenshots),
  };
}

type MetadataApi = ReturnType<typeof createAppStoreConnectListingMetadataApi>;
type ScreenshotApi = ReturnType<typeof createAppStoreConnectScreenshotApi>;

/*** Inspects editable App Store metadata and screenshot checksums. */
async function inspectAsync(
  context: StoreListingAdapterContext,
  runtime: AppStoreConnectRuntime,
  metadata: MetadataApi,
  screenshots: ScreenshotApi,
): Promise<DeploymentProviderResult<StoreListingTargetState>> {
  if (context.identity.target !== 'ios') return failed('APP_STORE_LISTING_IDENTITY_INVALID');
  const access = await runtime.resolveTokenAsync(context.credentials, context.resolveSecret);
  if (!access.ok) return { status: 'action-required', action: access.action };
  const resolved = await metadata.resolveContextAsync(
    context.identity.bundleIdentifier,
    access.token,
  );
  if (resolved === null) return editableRequired();
  const assetSets = await screenshots.readAssetsAsync(resolved.version, access.token);
  if (assetSets === null) return failed('APP_STORE_LISTING_INSPECTION_FAILED');
  return {
    status: 'completed',
    value: {
      target: 'ios',
      locales: mergeAppStoreListingLocales(resolved.appInfo, resolved.version),
      assetSets,
      supportedFields: SUPPORTED_FIELDS,
      diagnostics: [],
    },
  };
}

/*** Applies provider-neutral listing plan steps through App Store Connect. */
async function syncAsync(
  request: StoreListingSyncRequest,
  runtime: AppStoreConnectRuntime,
  metadata: MetadataApi,
  screenshots: ScreenshotApi,
): Promise<DeploymentProviderResult<StoreListingTargetState>> {
  if (request.identity.target !== 'ios') return failed('APP_STORE_LISTING_IDENTITY_INVALID');
  if (request.plan.status === 'blocked') return failed('APP_STORE_LISTING_PLAN_BLOCKED');
  if (request.plan.status === 'no-change') {
    return inspectAsync(request, runtime, metadata, screenshots);
  }
  const access = await runtime.resolveTokenAsync(request.credentials, request.resolveSecret);
  if (!access.ok) return { status: 'action-required', action: access.action };
  const initial = await metadata.resolveContextAsync(
    request.identity.bundleIdentifier,
    access.token,
  );
  if (initial === null) return editableRequired();
  const metadataSynced = await syncMetadataAsync(request, initial, access.token, metadata);
  if (!metadataSynced) return failed('APP_STORE_LISTING_SYNC_FAILED');
  const refreshed = await metadata.resolveContextAsync(
    request.identity.bundleIdentifier,
    access.token,
  );
  if (refreshed === null) return editableRequired();
  const assetsSynced = await syncAssetsAsync(request, refreshed.version, access.token, screenshots);
  if (!assetsSynced) return failed('APP_STORE_LISTING_SYNC_FAILED');
  return inspectAsync(request, runtime, metadata, screenshots);
}

/*** Synchronizes non-asset listing plan steps. */
async function syncMetadataAsync(
  request: StoreListingSyncRequest,
  context: NonNullable<Awaited<ReturnType<MetadataApi['resolveContextAsync']>>>,
  token: string,
  metadata: MetadataApi,
): Promise<boolean> {
  for (const step of request.plan.steps.filter((value) => value.operation !== 'replace-assets')) {
    if (step.target !== 'ios') continue;
    const desired = request.desired.locales.find((value) => value.locale === step.locale);
    if (desired === undefined || !(await metadata.writeLocaleAsync(context, desired, token))) {
      return false;
    }
  }
  return true;
}

/*** Synchronizes screenshot replacement plan steps. */
async function syncAssetsAsync(
  request: StoreListingSyncRequest,
  localizations: NonNullable<Awaited<ReturnType<MetadataApi['resolveContextAsync']>>>['version'],
  token: string,
  screenshots: ScreenshotApi,
): Promise<boolean> {
  for (const step of request.plan.steps.filter((value) => value.operation === 'replace-assets')) {
    if (step.target !== 'ios' || step.variant === undefined) continue;
    const localization = localizations.find((value) => value.locale === step.locale);
    const desired = request.desired.assetSets.find(
      (value) =>
        value.target === 'ios' && value.locale === step.locale && value.variant === step.variant,
    );
    if (localization === undefined || desired === undefined) return false;
    if (
      !(await screenshots.replaceAssetsAsync({
        request,
        localization,
        desired,
        token,
      }))
    ) {
      return false;
    }
  }
  return true;
}

/*** Returns the manual action required for editable App Store metadata. */
function editableRequired(): DeploymentProviderResult<StoreListingTargetState> {
  return {
    status: 'action-required',
    action: {
      type: 'manual-action',
      target: 'ios',
      provider: 'app-store-connect',
      code: 'APP_STORE_EDITABLE_LISTING_REQUIRED',
      message: 'An editable iOS App Store version is required for listing synchronization.',
    },
  };
}

/*** Creates a failed App Store listing result. */
function failed(code: string): DeploymentProviderResult<StoreListingTargetState> {
  return {
    status: 'failed',
    failure: {
      code,
      message: 'App Store Connect listing operation failed.',
      target: 'ios',
      provider: 'app-store-connect',
    },
  };
}
