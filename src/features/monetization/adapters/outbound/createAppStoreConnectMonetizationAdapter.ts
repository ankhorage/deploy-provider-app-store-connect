import type {
  DeploymentMonetizationAdapter,
  DeploymentProviderResult,
  MonetizationAdapterContext,
  MonetizationLocalization,
  MonetizationObservedProduct,
  MonetizationProduct,
  MonetizationSubscriptionPeriod,
  MonetizationSyncRequest,
  MonetizationTargetState,
} from '@ankhorage/contracts/deploy-provider';
import { isRecord } from '@ankhorage/utility/object';
import { isNonEmptyString } from '@ankhorage/utility/string';

import type { AppStoreConnectRuntime } from '../../../../utils/createAppStoreConnectRuntime.js';

const API = 'https://api.appstoreconnect.apple.com/v1';
const API_V2 = 'https://api.appstoreconnect.apple.com/v2';

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

/*** Inspects App Store in-app purchases and subscriptions. */
async function inspectAsync(
  context: MonetizationAdapterContext,
  runtime: AppStoreConnectRuntime,
): Promise<DeploymentProviderResult<MonetizationTargetState>> {
  if (context.identity.target !== 'ios') return failed('APP_STORE_MONETIZATION_IDENTITY_INVALID');
  const access = await runtime.resolveTokenAsync(context.credentials, context.resolveSecret);
  if (!access.ok) return { status: 'action-required', action: access.action };
  const appId = await findAppIdAsync(context.identity.bundleIdentifier, access.token, runtime);
  if (appId === null) return appRequired();
  const [iapValues, groupValues] = await Promise.all([
    readCollectionAsync(`${API}/apps/${encodeURIComponent(appId)}/inAppPurchasesV2?limit=200`, access.token, runtime),
    readCollectionAsync(
      `${API}/apps/${encodeURIComponent(appId)}/subscriptionGroups?include=subscriptions&limit=200&limit[subscriptions]=200`,
      access.token,
      runtime,
    ),
  ]);
  const families = groupValues.flatMap((value) =>
    isRecord(value) && isNonEmptyString(value.id) && isRecord(value.attributes) && isNonEmptyString(value.attributes.referenceName)
      ? [{ id: value.id, name: value.attributes.referenceName }]
      : [],
  );
  const includedSubscriptions = groupValues.flatMap((group) =>
    isRecord(group) &&
    isRecord(group.relationships) &&
    isRecord(group.relationships.subscriptions) &&
    Array.isArray(group.relationships.subscriptions.data)
      ? group.relationships.subscriptions.data
      : [],
  );
  const iaps = await Promise.all(iapValues.map((value) => normalizeIapAsync(value, access.token, runtime)));
  const subscriptions = await Promise.all(
    includedSubscriptions.map((value) => normalizeSubscriptionAsync(value, families, access.token, runtime)),
  );
  return {
    status: 'completed',
    value: {
      target: 'ios',
      products: [...iaps, ...subscriptions].filter(isObservedProduct),
      subscriptionFamilies: families.map((family) => family.name).sort(),
      diagnostics: [],
    },
  };
}

/*** Executes monetization plan steps with idempotent App Store product upserts. */
async function syncAsync(
  request: MonetizationSyncRequest,
  runtime: AppStoreConnectRuntime,
): Promise<DeploymentProviderResult<MonetizationTargetState>> {
  if (request.identity.target !== 'ios') return failed('APP_STORE_MONETIZATION_IDENTITY_INVALID');
  if (request.plan.status === 'blocked') return failed('APP_STORE_MONETIZATION_PLAN_BLOCKED');
  if (request.plan.status === 'no-change') return inspectAsync(request, runtime);
  const access = await runtime.resolveTokenAsync(request.credentials, request.resolveSecret);
  if (!access.ok) return { status: 'action-required', action: access.action };
  const appId = await findAppIdAsync(request.identity.bundleIdentifier, access.token, runtime);
  if (appId === null) return appRequired();
  for (const step of request.plan.steps) {
    if (step.target !== 'ios') continue;
    const product = request.desired.products.find((value) => value.id === step.productId);
    if (product === undefined) return failed('APP_STORE_MONETIZATION_PRODUCT_MISSING');
    const ok = await ensureProductAsync(appId, product, access.token, runtime);
    if (!ok) return failed('APP_STORE_MONETIZATION_SYNC_FAILED');
  }
  return inspectAsync(request, runtime);
}

/*** Ensures one App Store product, its localization metadata, and subscription family exist. */
async function ensureProductAsync(
  appId: string,
  product: MonetizationProduct,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<boolean> {
  if (product.kind === 'subscription') {
    const familyId = await ensureFamilyAsync(appId, product.subscription?.family ?? product.id, token, runtime);
    if (familyId === null) return false;
    const subscriptionId = await ensureSubscriptionAsync(familyId, product, token, runtime);
    return subscriptionId !== null && syncSubscriptionLocalizationsAsync(subscriptionId, product.localizations, token, runtime);
  }
  const iapId = await ensureIapAsync(appId, product, token, runtime);
  return iapId !== null && syncIapLocalizationsAsync(iapId, product.localizations, token, runtime);
}

/*** Finds or creates one App Store subscription group. */
async function ensureFamilyAsync(
  appId: string,
  family: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<string | null> {
  const groups = await readCollectionAsync(`${API}/apps/${encodeURIComponent(appId)}/subscriptionGroups?limit=200`, token, runtime);
  const existing = groups.find(
    (value) => isRecord(value) && isRecord(value.attributes) && value.attributes.referenceName === family,
  );
  if (isRecord(existing) && isNonEmptyString(existing.id)) return existing.id;
  const response = await safeRequestAsync(runtime, {
    method: 'POST',
    url: `${API}/subscriptionGroups`,
    token,
    body: JSON.stringify({
      data: {
        type: 'subscriptionGroups',
        attributes: { referenceName: family },
        relationships: { app: { data: { type: 'apps', id: appId } } },
      },
    }),
  });
  return response?.status === 201 ? readResourceId(response.body, 'subscriptionGroups') : null;
}

/*** Finds or creates one App Store subscription. */
async function ensureSubscriptionAsync(
  familyId: string,
  product: MonetizationProduct,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<string | null> {
  const values = await readCollectionAsync(`${API}/subscriptionGroups/${encodeURIComponent(familyId)}/subscriptions?limit=200`, token, runtime);
  const existing = values.find(
    (value) => isRecord(value) && isRecord(value.attributes) && value.attributes.productId === product.id,
  );
  if (isRecord(existing) && isNonEmptyString(existing.id)) return existing.id;
  const response = await safeRequestAsync(runtime, {
    method: 'POST',
    url: `${API}/subscriptions`,
    token,
    body: JSON.stringify({
      data: {
        type: 'subscriptions',
        attributes: {
          productId: product.id,
          name: product.localizations[0]?.name ?? product.id,
          subscriptionPeriod: toApplePeriod(product.subscription?.period ?? 'P1M'),
          familySharable: false,
        },
        relationships: { group: { data: { type: 'subscriptionGroups', id: familyId } } },
      },
    }),
  });
  return response?.status === 201 ? readResourceId(response.body, 'subscriptions') : null;
}

/*** Finds or creates one consumable or non-consumable App Store purchase. */
async function ensureIapAsync(
  appId: string,
  product: MonetizationProduct,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<string | null> {
  const values = await readCollectionAsync(`${API}/apps/${encodeURIComponent(appId)}/inAppPurchasesV2?limit=200`, token, runtime);
  const existing = values.find(
    (value) => isRecord(value) && isRecord(value.attributes) && value.attributes.productId === product.id,
  );
  if (isRecord(existing) && isNonEmptyString(existing.id)) return existing.id;
  const response = await safeRequestAsync(runtime, {
    method: 'POST',
    url: `${API_V2}/inAppPurchases`,
    token,
    body: JSON.stringify({
      data: {
        type: 'inAppPurchases',
        attributes: {
          name: product.localizations[0]?.name ?? product.id,
          productId: product.id,
          inAppPurchaseType: product.kind === 'consumable' ? 'CONSUMABLE' : 'NON_CONSUMABLE',
        },
        relationships: { app: { data: { type: 'apps', id: appId } } },
      },
    }),
  });
  return response?.status === 201 ? readResourceId(response.body, 'inAppPurchases') : null;
}

/*** Synchronizes subscription localizations through the public App Store API. */
async function syncSubscriptionLocalizationsAsync(
  subscriptionId: string,
  localizations: readonly MonetizationLocalization[],
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<boolean> {
  const existing = await readCollectionAsync(`${API}/subscriptions/${encodeURIComponent(subscriptionId)}/localizations?limit=200`, token, runtime);
  const writes = await Promise.all(
    localizations.map((localization) =>
      writeLocalizationAsync('subscriptionLocalizations', subscriptionId, localization, existing, token, runtime),
    ),
  );
  return writes.every(Boolean);
}

/*** Synchronizes in-app-purchase localizations through the public App Store API. */
async function syncIapLocalizationsAsync(
  iapId: string,
  localizations: readonly MonetizationLocalization[],
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<boolean> {
  const existing = await readCollectionAsync(`${API_V2}/inAppPurchases/${encodeURIComponent(iapId)}/localizations?limit=200`, token, runtime);
  const writes = await Promise.all(
    localizations.map((localization) =>
      writeLocalizationAsync('inAppPurchaseLocalizations', iapId, localization, existing, token, runtime),
    ),
  );
  return writes.every(Boolean);
}

/*** Creates or patches one monetization localization. */
async function writeLocalizationAsync(
  type: 'inAppPurchaseLocalizations' | 'subscriptionLocalizations',
  ownerId: string,
  localization: MonetizationLocalization,
  existing: readonly unknown[],
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<boolean> {
  const current = existing.find(
    (value) => isRecord(value) && isRecord(value.attributes) && value.attributes.locale === localization.locale,
  );
  const id = isRecord(current) && isNonEmptyString(current.id) ? current.id : undefined;
  const ownerType = type === 'inAppPurchaseLocalizations' ? 'inAppPurchaseV2' : 'subscription';
  const response = await safeRequestAsync(runtime, {
    method: id === undefined ? 'POST' : 'PATCH',
    url: id === undefined
      ? `${API_V2}/${type}`
      : `${API_V2}/${type}/${encodeURIComponent(id)}`,
    token,
    body: JSON.stringify({
      data: {
        type,
        ...(id === undefined ? {} : { id }),
        attributes: {
          locale: localization.locale,
          name: localization.name,
          description: localization.description,
        },
        ...(id === undefined
          ? { relationships: { [ownerType]: { data: { type: `${ownerType}s`, id: ownerId } } } }
          : {}),
      },
    }),
  });
  return response !== null && isSuccess(response.status);
}

/*** Normalizes one App Store in-app purchase into the portable observed product model. */
async function normalizeIapAsync(
  value: unknown,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<MonetizationObservedProduct | null> {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isRecord(value.attributes)) return null;
  if (!isNonEmptyString(value.attributes.productId)) return null;
  const localizations = await readLocalizationsAsync(
    `${API_V2}/inAppPurchases/${encodeURIComponent(value.id)}/localizations?limit=200`,
    token,
    runtime,
  );
  const kind = value.attributes.inAppPurchaseType === 'CONSUMABLE' ? 'consumable' : 'non-consumable';
  return { id: value.attributes.productId, kind, localizations };
}

/*** Normalizes one subscription relationship into the portable observed product model. */
async function normalizeSubscriptionAsync(
  value: unknown,
  families: readonly { readonly id: string; readonly name: string }[],
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<MonetizationObservedProduct | null> {
  if (!isRecord(value) || !isNonEmptyString(value.id)) return null;
  const response = await safeRequestAsync(runtime, { method: 'GET', url: `${API}/subscriptions/${encodeURIComponent(value.id)}`, token });
  const resource = response === null ? null : parseResource(response.body);
  if (resource === null || !isRecord(resource.attributes) || !isNonEmptyString(resource.attributes.productId)) return null;
  const localizations = await readLocalizationsAsync(
    `${API}/subscriptions/${encodeURIComponent(value.id)}/localizations?limit=200`,
    token,
    runtime,
  );
  const familyId = readRelationshipId(resource.relationships, 'group', 'subscriptionGroups');
  const family = families.find((item) => item.id === familyId)?.name ?? resource.attributes.productId;
  const period = fromApplePeriod(resource.attributes.subscriptionPeriod);
  return {
    id: resource.attributes.productId,
    kind: 'subscription',
    localizations,
    ...(period === null ? {} : { subscription: { family, period } }),
  };
}

/*** Reads portable monetization localizations from a provider collection. */
async function readLocalizationsAsync(
  url: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<readonly MonetizationLocalization[]> {
  const values = await readCollectionAsync(url, token, runtime);
  return values.flatMap((value) =>
    isRecord(value) &&
    isRecord(value.attributes) &&
    isNonEmptyString(value.attributes.locale) &&
    isNonEmptyString(value.attributes.name) &&
    typeof value.attributes.description === 'string'
      ? [{ locale: value.attributes.locale, name: value.attributes.name, description: value.attributes.description }]
      : [],
  );
}

/*** Maps the portable subscription period to Apple's duration identifier. */
function toApplePeriod(period: MonetizationSubscriptionPeriod): string {
  return ({ P1W: 'ONE_WEEK', P1M: 'ONE_MONTH', P2M: 'TWO_MONTHS', P3M: 'THREE_MONTHS', P6M: 'SIX_MONTHS', P1Y: 'ONE_YEAR' } as const)[period];
}

/*** Maps Apple's duration identifier to the portable subscription period. */
function fromApplePeriod(value: unknown): MonetizationSubscriptionPeriod | null {
  const entry = Object.entries({ P1W: 'ONE_WEEK', P1M: 'ONE_MONTH', P2M: 'TWO_MONTHS', P3M: 'THREE_MONTHS', P6M: 'SIX_MONTHS', P1Y: 'ONE_YEAR' } as const).find(([, apple]) => apple === value);
  return entry?.[0] as MonetizationSubscriptionPeriod | undefined ?? null;
}

/*** Finds the App Store app matching one bundle identifier. */
async function findAppIdAsync(
  bundleIdentifier: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<string | null> {
  const values = await readCollectionAsync(`${API}/apps?filter[bundleId]=${encodeURIComponent(bundleIdentifier)}&limit=2`, token, runtime);
  const match = values.find(
    (value) => isRecord(value) && isRecord(value.attributes) && value.attributes.bundleId === bundleIdentifier,
  );
  return isRecord(match) && isNonEmptyString(match.id) ? match.id : null;
}

/*** Reads one JSON:API collection. */
async function readCollectionAsync(
  url: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<readonly unknown[]> {
  const response = await safeRequestAsync(runtime, { method: 'GET', url, token });
  if (response === null || !isSuccess(response.status)) return [];
  const value = parseJson(response.body);
  return isRecord(value) && Array.isArray(value.data) ? value.data : [];
}

/*** Executes one provider request while containing transport failures. */
async function safeRequestAsync(
  runtime: AppStoreConnectRuntime,
  request: Parameters<AppStoreConnectRuntime['request']>[0],
): ReturnType<AppStoreConnectRuntime['request']> | Promise<null> {
  try {
    return await runtime.request(request);
  } catch {
    return null;
  }
}

/*** Reads one JSON:API resource object. */
function parseResource(body: string): Record<string, unknown> | null {
  const value = parseJson(body);
  return isRecord(value) && isRecord(value.data) ? value.data : null;
}

/*** Reads a JSON:API resource id. */
function readResourceId(body: string, type: string): string | null {
  const value = parseResource(body);
  return value !== null && value.type === type && isNonEmptyString(value.id) ? value.id : null;
}

/*** Reads one relationship id from a JSON:API resource. */
function readRelationshipId(value: unknown, name: string, type: string): string | null {
  if (!isRecord(value) || !isRecord(value[name]) || !isRecord(value[name].data)) return null;
  const data = value[name].data;
  return data.type === type && isNonEmptyString(data.id) ? data.id : null;
}

/*** Parses JSON without exposing parser exceptions. */
function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

/*** Tests whether an HTTP status code is successful. */
function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/*** Narrows nullable observed products. */
function isObservedProduct(value: MonetizationObservedProduct | null): value is MonetizationObservedProduct {
  return value !== null;
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
