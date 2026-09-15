import type {
  MonetizationLocalization,
  MonetizationObservedProduct,
  MonetizationSubscriptionPeriod,
  MonetizationTargetState,
} from '@ankhorage/contracts/deploy-provider';
import { isRecord } from '@ankhorage/utility/object';
import { isNonEmptyString } from '@ankhorage/utility/string';

import type { AppStoreConnectRuntime } from '../../../../utils/createAppStoreConnectRuntime.js';

const API = 'https://api.appstoreconnect.apple.com/v1';
const API_V2 = 'https://api.appstoreconnect.apple.com/v2';

/*** Inspects App Store in-app purchases and subscriptions into the portable state model. */
export async function inspectAppStoreConnectMonetizationAsync(options: {
  readonly appId: string;
  readonly token: string;
  readonly runtime: AppStoreConnectRuntime;
}): Promise<MonetizationTargetState | null> {
  const [iapValues, groups] = await Promise.all([
    readCollectionAsync(
      `${API}/apps/${encodeURIComponent(options.appId)}/inAppPurchasesV2?limit=200`,
      options,
    ),
    readCollectionAsync(
      `${API}/apps/${encodeURIComponent(options.appId)}/subscriptionGroups?include=subscriptions&limit=200&limit[subscriptions]=200`,
      options,
    ),
  ]);
  if (iapValues === null || groups === null) return null;
  const families = readFamilies(groups);
  const relationshipSubscriptions = readSubscriptionRelationships(groups);
  const iaps = await Promise.all(
    iapValues.map((value) => normalizeIapAsync(value, options.token, options.runtime)),
  );
  const subscriptions = await Promise.all(
    relationshipSubscriptions.map((value) =>
      normalizeSubscriptionAsync(value, families, options.token, options.runtime),
    ),
  );
  return {
    target: 'ios',
    products: [...iaps, ...subscriptions].filter(isObservedProduct),
    subscriptionFamilies: families.map((family) => family.name).sort(),
    diagnostics: [],
  };
}

/*** Reads subscription-family ids and canonical names. */
function readFamilies(
  values: readonly unknown[],
): readonly { readonly id: string; readonly name: string }[] {
  return values.flatMap((value) => {
    if (!isRecord(value) || !isNonEmptyString(value.id) || !isRecord(value.attributes)) return [];
    return isNonEmptyString(value.attributes.referenceName)
      ? [{ id: value.id, name: value.attributes.referenceName }]
      : [];
  });
}

/*** Reads subscription relationship resources from subscription groups. */
function readSubscriptionRelationships(values: readonly unknown[]): readonly unknown[] {
  return values.flatMap((group) => {
    if (!isRecord(group) || !isRecord(group.relationships)) return [];
    if (!isRecord(group.relationships.subscriptions)) return [];
    return unknownArray(group.relationships.subscriptions.data);
  });
}

/*** Normalizes one App Store in-app purchase. */
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
  if (localizations === null) return null;
  const kind = value.attributes.inAppPurchaseType === 'CONSUMABLE' ? 'consumable' : 'non-consumable';
  return { id: value.attributes.productId, kind, localizations };
}

/*** Normalizes one App Store subscription. */
async function normalizeSubscriptionAsync(
  value: unknown,
  families: readonly { readonly id: string; readonly name: string }[],
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<MonetizationObservedProduct | null> {
  if (!isRecord(value) || !isNonEmptyString(value.id)) return null;
  const response = await safeRequestAsync(runtime, {
    method: 'GET',
    url: `${API}/subscriptions/${encodeURIComponent(value.id)}`,
    token,
  });
  if (response === null || !isSuccess(response.status)) return null;
  const resource = parseResource(response.body);
  if (resource === null || !isRecord(resource.attributes)) return null;
  if (!isNonEmptyString(resource.attributes.productId)) return null;
  const localizations = await readLocalizationsAsync(
    `${API}/subscriptions/${encodeURIComponent(value.id)}/localizations?limit=200`,
    token,
    runtime,
  );
  if (localizations === null) return null;
  const familyId = readGroupRelationshipId(resource);
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
): Promise<readonly MonetizationLocalization[] | null> {
  const values = await readCollectionAsync(url, { token, runtime });
  if (values === null) return null;
  return values.flatMap((value) => {
    if (!isRecord(value) || !isRecord(value.attributes)) return [];
    const { locale, name, description } = value.attributes;
    return isNonEmptyString(locale) && isNonEmptyString(name) && typeof description === 'string'
      ? [{ locale, name, description }]
      : [];
  });
}

/*** Reads a JSON:API collection while distinguishing transport failure from an empty collection. */
async function readCollectionAsync(
  url: string,
  options: { readonly token: string; readonly runtime: AppStoreConnectRuntime },
): Promise<readonly unknown[] | null> {
  const response = await safeRequestAsync(options.runtime, {
    method: 'GET',
    url,
    token: options.token,
  });
  if (response === null || !isSuccess(response.status)) return null;
  const root = parseJson(response.body);
  return isRecord(root) && Array.isArray(root.data) ? unknownArray(root.data) : null;
}

/*** Reads the subscription-group relationship id. */
function readGroupRelationshipId(value: Readonly<Record<string, unknown>>): string | null {
  if (!isRecord(value.relationships) || !isRecord(value.relationships.group)) return null;
  const data = value.relationships.group.data;
  return isRecord(data) && data.type === 'subscriptionGroups' && isNonEmptyString(data.id)
    ? data.id
    : null;
}

/*** Maps Apple's subscription duration to the portable period. */
function fromApplePeriod(value: unknown): MonetizationSubscriptionPeriod | null {
  switch (value) {
    case 'ONE_WEEK':
      return 'P1W';
    case 'ONE_MONTH':
      return 'P1M';
    case 'TWO_MONTHS':
      return 'P2M';
    case 'THREE_MONTHS':
      return 'P3M';
    case 'SIX_MONTHS':
      return 'P6M';
    case 'ONE_YEAR':
      return 'P1Y';
    default:
      return null;
  }
}

/*** Narrows nullable observed products. */
function isObservedProduct(
  value: MonetizationObservedProduct | null,
): value is MonetizationObservedProduct {
  return value !== null;
}

/*** Reads one JSON:API resource. */
function parseResource(body: string): Record<string, unknown> | null {
  const root = parseJson(body);
  return isRecord(root) && isRecord(root.data) ? root.data : null;
}

/*** Converts an unknown array boundary into a typed unknown list. */
function unknownArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value.map((item: unknown) => item) : [];
}

/*** Executes one App Store request while containing transport errors. */
async function safeRequestAsync(
  runtime: AppStoreConnectRuntime,
  request: Parameters<AppStoreConnectRuntime['request']>[0],
): Promise<Awaited<ReturnType<AppStoreConnectRuntime['request']>> | null> {
  try {
    return await runtime.request(request);
  } catch {
    return null;
  }
}

/*** Parses JSON without leaking parser exceptions. */
function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

/*** Tests whether an HTTP status is successful. */
function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}
