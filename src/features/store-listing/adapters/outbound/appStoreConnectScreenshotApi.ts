import type {
  StoreListingAssetSet,
  StoreListingRemoteAssetSet,
  StoreListingSyncRequest,
} from '@ankhorage/contracts/deploy-provider';
import { isRecord } from '@ankhorage/utility/object';
import { isNonEmptyString } from '@ankhorage/utility/string';

import type { AppStoreListingResource } from '../../../../types/appStoreConnectListing.js';
import type { AppStoreConnectRuntime } from '../../../../utils/createAppStoreConnectRuntime.js';
import { createAppStoreConnectScreenshotUploadApi } from './appStoreConnectScreenshotUploadApi.js';

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
  const upload = createAppStoreConnectScreenshotUploadApi(runtime);
  return {
    readAssetsAsync: (localizations, token) => readAssetsAsync(localizations, token, runtime),
    replaceAssetsAsync: (options) => replaceAssetsAsync(options, runtime, upload),
  };
}

type UploadApi = ReturnType<typeof createAppStoreConnectScreenshotUploadApi>;

/*** Reads screenshot sets and provider checksum state for all version localizations. */
async function readAssetsAsync(
  localizations: readonly AppStoreListingResource[],
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<readonly StoreListingRemoteAssetSet[] | null> {
  const result: StoreListingRemoteAssetSet[] = [];
  for (const localization of localizations) {
    const assets = await readLocalizationAssetsAsync(localization, token, runtime);
    if (assets === null) return null;
    result.push(...assets);
  }
  return result;
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
  const result: StoreListingRemoteAssetSet[] = [];
  for (const set of sets) {
    const parsed = await readScreenshotSetAsync(localization.locale, set, token, runtime);
    if (parsed === null) return null;
    result.push(parsed);
  }
  return result;
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
  upload: UploadApi,
): Promise<boolean> {
  const setId = await ensureScreenshotSetAsync(
    options.localization.id,
    options.desired.variant,
    options.token,
    runtime,
  );
  if (setId === null) return false;
  if (!(await clearScreenshotsAsync(setId, options.token, runtime))) return false;
  return upload.uploadAssetsAsync(setId, options.request, options.desired, options.token);
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
