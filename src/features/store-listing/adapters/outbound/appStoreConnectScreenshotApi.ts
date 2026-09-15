import type {
  StoreListingAssetSet,
  StoreListingRemoteAssetSet,
  StoreListingSyncRequest,
} from '@ankhorage/contracts/deploy-provider';
import { isRecord } from '@ankhorage/utility/object';
import { isNonEmptyString } from '@ankhorage/utility/string';

import type { AppStoreListingResource } from '../../../../types/appStoreConnectListing.js';
import type { AppStoreConnectRuntime } from '../../../../utils/createAppStoreConnectRuntime.js';

const API = 'https://api.appstoreconnect.apple.com/v1';

export interface AppStoreConnectScreenshotApi {
  readAssetsAsync(
    localizations: readonly AppStoreListingResource[],
    token: string,
  ): Promise<readonly StoreListingRemoteAssetSet[] | null>;
  replaceAssetsAsync(options: {
    readonly request: StoreListingSyncRequest;
    readonly localization: AppStoreListingResource;
    readonly desired: StoreListingAssetSet;
    readonly token: string;
  }): Promise<boolean>;
}

/*** Creates App Store Connect screenshot read and replacement operations. */
export function createAppStoreConnectScreenshotApi(
  runtime: AppStoreConnectRuntime,
): AppStoreConnectScreenshotApi {
  return {
    readAssetsAsync: (localizations, token) => readAssetsAsync(localizations, token, runtime),
    replaceAssetsAsync: (options) => replaceAssetsAsync(options, runtime),
  };
}

/*** Reads screenshot sets and provider checksum state for all version localizations. */
async function readAssetsAsync(
  localizations: readonly AppStoreListingResource[],
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<readonly StoreListingRemoteAssetSet[] | null> {
  const nested = await Promise.all(
    localizations.map((localization) => readLocalizationAssetsAsync(localization, token, runtime)),
  );
  return nested.some((value) => value === null) ? null : nested.flatMap((value) => value ?? []);
}

/*** Reads screenshot sets for one App Store version localization. */
async function readLocalizationAssetsAsync(
  localization: AppStoreListingResource,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<readonly StoreListingRemoteAssetSet[] | null> {
  const sets = await readCollectionAsync(
    `${API}/appStoreVersionLocalizations/${encodeURIComponent(localization.id)}/appScreenshotSets?limit=200`,
    token,
    runtime,
  );
  if (sets === null) return null;
  const values = await Promise.all(
    sets.map((set) => readScreenshotSetAsync(localization.locale, set, token, runtime)),
  );
  return values.every((value) => value !== null) ? values.filter((value) => value !== null) : null;
}

/*** Reads one screenshot set and its source-file checksums. */
async function readScreenshotSetAsync(
  locale: string,
  value: unknown,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<StoreListingRemoteAssetSet | null> {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isRecord(value.attributes)) return null;
  if (!isNonEmptyString(value.attributes.screenshotDisplayType)) return null;
  const screenshots = await readCollectionAsync(
    `${API}/appScreenshotSets/${encodeURIComponent(value.id)}/appScreenshots?limit=200`,
    token,
    runtime,
  );
  if (screenshots === null) return null;
  const hashes = screenshots.flatMap((shot) => {
    if (!isRecord(shot) || !isRecord(shot.attributes)) return [];
    return isNonEmptyString(shot.attributes.sourceFileChecksum)
      ? [shot.attributes.sourceFileChecksum]
      : [];
  });
  return {
    target: 'ios',
    locale,
    variant: value.attributes.screenshotDisplayType,
    checksum: 'md5',
    hashes,
  };
}

/*** Replaces one screenshot set from portable desired asset bytes. */
async function replaceAssetsAsync(
  options: {
    readonly request: StoreListingSyncRequest;
    readonly localization: AppStoreListingResource;
    readonly desired: StoreListingAssetSet;
    readonly token: string;
  },
  runtime: AppStoreConnectRuntime,
): Promise<boolean> {
  const setId = await ensureScreenshotSetAsync(
    options.localization.id,
    options.desired.variant,
    options.token,
    runtime,
  );
  if (setId === null) return false;
  if (!(await clearScreenshotsAsync(setId, options.token, runtime))) return false;
  for (const asset of options.desired.assets) {
    const bytes = await options.request.assets.readAsync(asset.relativePath);
    const uploaded = await uploadScreenshotAsync(
      setId,
      asset.relativePath,
      bytes,
      options.token,
      runtime,
    );
    if (!uploaded) return false;
  }
  return true;
}

/*** Finds or creates one screenshot set for a display variant. */
async function ensureScreenshotSetAsync(
  localizationId: string,
  variant: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<string | null> {
  const sets = await readCollectionAsync(
    `${API}/appStoreVersionLocalizations/${encodeURIComponent(localizationId)}/appScreenshotSets?limit=200`,
    token,
    runtime,
  );
  if (sets === null) return null;
  const existing = sets.find((value) => matchesScreenshotVariant(value, variant));
  if (isRecord(existing) && isNonEmptyString(existing.id)) return existing.id;
  const response = await safeRequestAsync(runtime, {
    method: 'POST',
    url: `${API}/appScreenshotSets`,
    token,
    body: JSON.stringify({
      data: {
        type: 'appScreenshotSets',
        attributes: { screenshotDisplayType: variant },
        relationships: {
          appStoreVersionLocalization: {
            data: { type: 'appStoreVersionLocalizations', id: localizationId },
          },
        },
      },
    }),
  });
  return response?.status === 201 ? readResourceId(response.body, 'appScreenshotSets') : null;
}

/*** Checks whether one screenshot set uses a requested display variant. */
function matchesScreenshotVariant(value: unknown, variant: string): boolean {
  return (
    isRecord(value) &&
    isRecord(value.attributes) &&
    value.attributes.screenshotDisplayType === variant
  );
}

/*** Deletes all current screenshots from one screenshot set. */
async function clearScreenshotsAsync(
  setId: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<boolean> {
  const existing = await readCollectionAsync(
    `${API}/appScreenshotSets/${encodeURIComponent(setId)}/appScreenshots?limit=200`,
    token,
    runtime,
  );
  if (existing === null) return false;
  const responses = await Promise.all(
    existing.flatMap((value) =>
      isRecord(value) && isNonEmptyString(value.id)
        ? [
            safeRequestAsync(runtime, {
              method: 'DELETE',
              url: `${API}/appScreenshots/${encodeURIComponent(value.id)}`,
              token,
            }),
          ]
        : [],
    ),
  );
  return responses.every((response) => response !== null && isSuccess(response.status));
}

/*** Reserves, transfers, and commits one App Store screenshot. */
async function uploadScreenshotAsync(
  setId: string,
  fileName: string,
  bytes: Uint8Array,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<boolean> {
  const reservation = await reserveScreenshotAsync(
    setId,
    fileName,
    bytes.byteLength,
    token,
    runtime,
  );
  if (reservation === null) return false;
  const statuses = await Promise.all(
    reservation.operations.map((operation) =>
      runtime.upload({
        method: operation.method,
        url: operation.url,
        headers: operation.headers,
        body: bytes.slice(operation.offset, operation.offset + operation.length),
      }),
    ),
  );
  if (!statuses.every(isSuccess)) return false;
  const committed = await safeRequestAsync(runtime, {
    method: 'PATCH',
    url: `${API}/appScreenshots/${encodeURIComponent(reservation.id)}`,
    token,
    body: JSON.stringify({
      data: { type: 'appScreenshots', id: reservation.id, attributes: { uploaded: true } },
    }),
  });
  return committed !== null && isSuccess(committed.status);
}

interface ScreenshotReservation {
  readonly id: string;
  readonly operations: readonly {
    readonly offset: number;
    readonly length: number;
    readonly method: string;
    readonly url: string;
    readonly headers: readonly { readonly name: string; readonly value: string }[];
  }[];
}

/*** Reserves signed upload operations for one screenshot. */
async function reserveScreenshotAsync(
  setId: string,
  fileName: string,
  fileSize: number,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<ScreenshotReservation | null> {
  const response = await safeRequestAsync(runtime, {
    method: 'POST',
    url: `${API}/appScreenshots`,
    token,
    body: JSON.stringify({
      data: {
        type: 'appScreenshots',
        attributes: { fileName, fileSize },
        relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: setId } } },
      },
    }),
  });
  if (response?.status !== 201) return null;
  const root = parseJson(response.body);
  if (!isRecord(root) || !isRecord(root.data) || !isNonEmptyString(root.data.id)) return null;
  if (!isRecord(root.data.attributes)) return null;
  const operations = unknownArray(root.data.attributes.uploadOperations).map(parseUploadOperation);
  return operations.every((operation) => operation !== null)
    ? { id: root.data.id, operations: operations.filter((operation) => operation !== null) }
    : null;
}

/*** Parses one screenshot upload operation. */
function parseUploadOperation(value: unknown): ScreenshotReservation['operations'][number] | null {
  if (!isRecord(value)) return null;
  const { offset, length, method, url } = value;
  if (typeof offset !== 'number' || typeof length !== 'number') return null;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0)
    return null;
  if (!isNonEmptyString(method) || !isNonEmptyString(url)) return null;
  const headers = unknownArray(value.requestHeaders).flatMap((header) =>
    isRecord(header) && isNonEmptyString(header.name) && typeof header.value === 'string'
      ? [{ name: header.name, value: header.value }]
      : [],
  );
  return { offset, length, method, url, headers };
}

/*** Reads one JSON:API collection. */
async function readCollectionAsync(
  url: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<readonly unknown[] | null> {
  const response = await safeRequestAsync(runtime, { method: 'GET', url, token });
  if (response === null || !isSuccess(response.status)) return null;
  const root = parseJson(response.body);
  return isRecord(root) && Array.isArray(root.data) ? root.data.map((item: unknown) => item) : null;
}

/*** Executes one provider request while containing transport errors. */
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

/*** Reads a JSON:API resource id. */
function readResourceId(body: string, type: string): string | null {
  const root = parseJson(body);
  return isRecord(root) &&
    isRecord(root.data) &&
    root.data.type === type &&
    isNonEmptyString(root.data.id)
    ? root.data.id
    : null;
}

/*** Converts an unknown array boundary into a typed unknown list. */
function unknownArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value.map((item: unknown) => item) : [];
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
