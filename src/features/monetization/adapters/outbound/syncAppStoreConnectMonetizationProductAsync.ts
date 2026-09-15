import type {
  MonetizationLocalization,
  MonetizationProduct,
  MonetizationSubscriptionPeriod,
} from '@ankhorage/contracts/deploy-provider';
import { isRecord } from '@ankhorage/utility/object';
import { isNonEmptyString } from '@ankhorage/utility/string';

import type { AppStoreConnectRuntime } from '../../../../utils/createAppStoreConnectRuntime.js';

const API = 'https://api.appstoreconnect.apple.com/v1';
const API_V2 = 'https://api.appstoreconnect.apple.com/v2';

/*** Ensures one App Store product and its localization metadata exist. */
export async function syncAppStoreConnectMonetizationProductAsync(options: {
  readonly appId: string;
  readonly product: MonetizationProduct;
  readonly token: string;
  readonly runtime: AppStoreConnectRuntime;
}): Promise<boolean> {
  if (options.product.kind === 'subscription') {
    const familyId = await ensureFamilyAsync(options);
    if (familyId === null) return false;
    const productId = await ensureSubscriptionAsync(familyId, options);
    return productId !== null && syncSubscriptionLocalizationsAsync(productId, options);
  }
  const productId = await ensureIapAsync(options);
  return productId !== null && syncIapLocalizationsAsync(productId, options);
}

/*** Finds or creates the subscription group for one portable subscription family. */
async function ensureFamilyAsync(options: {
  readonly appId: string;
  readonly product: MonetizationProduct;
  readonly token: string;
  readonly runtime: AppStoreConnectRuntime;
}): Promise<string | null> {
  const family = options.product.subscription?.family ?? options.product.id;
  const values = await readCollectionAsync(
    `${API}/apps/${encodeURIComponent(options.appId)}/subscriptionGroups?limit=200`,
    options.token,
    options.runtime,
  );
  if (values === null) return null;
  const existing = values.find((value) => matchesAttribute(value, 'referenceName', family));
  if (isRecord(existing) && isNonEmptyString(existing.id)) return existing.id;
  const response = await safeRequestAsync(options.runtime, {
    method: 'POST',
    url: `${API}/subscriptionGroups`,
    token: options.token,
    body: JSON.stringify({
      data: {
        type: 'subscriptionGroups',
        attributes: { referenceName: family },
        relationships: { app: { data: { type: 'apps', id: options.appId } } },
      },
    }),
  });
  return response?.status === 201 ? readResourceId(response.body, 'subscriptionGroups') : null;
}

/*** Finds or creates one App Store subscription in a subscription group. */
async function ensureSubscriptionAsync(
  familyId: string,
  options: {
    readonly product: MonetizationProduct;
    readonly token: string;
    readonly runtime: AppStoreConnectRuntime;
  },
): Promise<string | null> {
  const values = await readCollectionAsync(
    `${API}/subscriptionGroups/${encodeURIComponent(familyId)}/subscriptions?limit=200`,
    options.token,
    options.runtime,
  );
  if (values === null) return null;
  const existing = values.find((value) => matchesAttribute(value, 'productId', options.product.id));
  if (isRecord(existing) && isNonEmptyString(existing.id)) return existing.id;
  const response = await safeRequestAsync(options.runtime, {
    method: 'POST',
    url: `${API}/subscriptions`,
    token: options.token,
    body: JSON.stringify({
      data: {
        type: 'subscriptions',
        attributes: {
          productId: options.product.id,
          name: options.product.localizations.at(0)?.name ?? options.product.id,
          subscriptionPeriod: toApplePeriod(options.product.subscription?.period ?? 'P1M'),
          familySharable: false,
        },
        relationships: { group: { data: { type: 'subscriptionGroups', id: familyId } } },
      },
    }),
  });
  return response?.status === 201 ? readResourceId(response.body, 'subscriptions') : null;
}

/*** Finds or creates one consumable or non-consumable in-app purchase. */
async function ensureIapAsync(options: {
  readonly appId: string;
  readonly product: MonetizationProduct;
  readonly token: string;
  readonly runtime: AppStoreConnectRuntime;
}): Promise<string | null> {
  const values = await readCollectionAsync(
    `${API}/apps/${encodeURIComponent(options.appId)}/inAppPurchasesV2?limit=200`,
    options.token,
    options.runtime,
  );
  if (values === null) return null;
  const existing = values.find((value) => matchesAttribute(value, 'productId', options.product.id));
  if (isRecord(existing) && isNonEmptyString(existing.id)) return existing.id;
  const response = await safeRequestAsync(options.runtime, {
    method: 'POST',
    url: `${API_V2}/inAppPurchases`,
    token: options.token,
    body: JSON.stringify({
      data: {
        type: 'inAppPurchases',
        attributes: {
          name: options.product.localizations.at(0)?.name ?? options.product.id,
          productId: options.product.id,
          inAppPurchaseType:
            options.product.kind === 'consumable' ? 'CONSUMABLE' : 'NON_CONSUMABLE',
        },
        relationships: { app: { data: { type: 'apps', id: options.appId } } },
      },
    }),
  });
  return response?.status === 201 ? readResourceId(response.body, 'inAppPurchases') : null;
}

/*** Synchronizes subscription localizations. */
async function syncSubscriptionLocalizationsAsync(
  subscriptionId: string,
  options: {
    readonly product: MonetizationProduct;
    readonly token: string;
    readonly runtime: AppStoreConnectRuntime;
  },
): Promise<boolean> {
  const existing = await readCollectionAsync(
    `${API}/subscriptions/${encodeURIComponent(subscriptionId)}/localizations?limit=200`,
    options.token,
    options.runtime,
  );
  if (existing === null) return false;
  const writes = await Promise.all(
    options.product.localizations.map((localization) =>
      writeLocalizationAsync({
        type: 'subscriptionLocalizations',
        ownerType: 'subscriptions',
        ownerId: subscriptionId,
        localization,
        existing,
        token: options.token,
        runtime: options.runtime,
      }),
    ),
  );
  return writes.every(Boolean);
}

/*** Synchronizes in-app-purchase localizations. */
async function syncIapLocalizationsAsync(
  iapId: string,
  options: {
    readonly product: MonetizationProduct;
    readonly token: string;
    readonly runtime: AppStoreConnectRuntime;
  },
): Promise<boolean> {
  const existing = await readCollectionAsync(
    `${API_V2}/inAppPurchases/${encodeURIComponent(iapId)}/localizations?limit=200`,
    options.token,
    options.runtime,
  );
  if (existing === null) return false;
  const writes = await Promise.all(
    options.product.localizations.map((localization) =>
      writeLocalizationAsync({
        type: 'inAppPurchaseLocalizations',
        ownerType: 'inAppPurchases',
        ownerId: iapId,
        localization,
        existing,
        token: options.token,
        runtime: options.runtime,
      }),
    ),
  );
  return writes.every(Boolean);
}

/*** Creates or patches one monetization localization. */
async function writeLocalizationAsync(options: {
  readonly type: 'inAppPurchaseLocalizations' | 'subscriptionLocalizations';
  readonly ownerType: 'inAppPurchases' | 'subscriptions';
  readonly ownerId: string;
  readonly localization: MonetizationLocalization;
  readonly existing: readonly unknown[];
  readonly token: string;
  readonly runtime: AppStoreConnectRuntime;
}): Promise<boolean> {
  const current = options.existing.find(
    (value) =>
      isRecord(value) &&
      isRecord(value.attributes) &&
      value.attributes.locale === options.localization.locale,
  );
  const id = isRecord(current) && isNonEmptyString(current.id) ? current.id : undefined;
  const response = await safeRequestAsync(options.runtime, {
    method: id === undefined ? 'POST' : 'PATCH',
    url:
      id === undefined
        ? `${API_V2}/${options.type}`
        : `${API_V2}/${options.type}/${encodeURIComponent(id)}`,
    token: options.token,
    body: JSON.stringify({
      data: {
        type: options.type,
        ...(id === undefined ? {} : { id }),
        attributes: {
          locale: options.localization.locale,
          name: options.localization.name,
          description: options.localization.description,
        },
        ...(id === undefined
          ? {
              relationships: {
                product: { data: { type: options.ownerType, id: options.ownerId } },
              },
            }
          : {}),
      },
    }),
  });
  return response !== null && isSuccess(response.status);
}

/*** Checks one known provider attribute without dynamic object indexing. */
function matchesAttribute(value: unknown, key: 'productId' | 'referenceName', expected: string): boolean {
  if (!isRecord(value) || !isRecord(value.attributes)) return false;
  return key === 'productId'
    ? value.attributes.productId === expected
    : value.attributes.referenceName === expected;
}

/*** Maps the portable subscription duration to Apple's duration identifier. */
function toApplePeriod(period: MonetizationSubscriptionPeriod): string {
  switch (period) {
    case 'P1W':
      return 'ONE_WEEK';
    case 'P1M':
      return 'ONE_MONTH';
    case 'P2M':
      return 'TWO_MONTHS';
    case 'P3M':
      return 'THREE_MONTHS';
    case 'P6M':
      return 'SIX_MONTHS';
    case 'P1Y':
      return 'ONE_YEAR';
  }
}

/*** Reads one JSON:API collection while preserving request failure. */
async function readCollectionAsync(
  url: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<readonly unknown[] | null> {
  const response = await safeRequestAsync(runtime, { method: 'GET', url, token });
  if (response === null || !isSuccess(response.status)) return null;
  const root = parseJson(response.body);
  return isRecord(root) && Array.isArray(root.data) ? unknownArray(root.data) : null;
}

/*** Reads one JSON:API resource id. */
function readResourceId(body: string, type: string): string | null {
  const root = parseJson(body);
  return isRecord(root) && isRecord(root.data) && root.data.type === type && isNonEmptyString(root.data.id)
    ? root.data.id
    : null;
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
