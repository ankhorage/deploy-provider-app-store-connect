import type {
  DeploymentProviderResult,
  DeploymentStoreListingAdapter,
  StoreListingAdapterContext,
  StoreListingLocale,
  StoreListingRemoteAssetSet,
  StoreListingSyncRequest,
  StoreListingTargetState,
} from '@ankhorage/contracts/deploy-provider';
import { isRecord } from '@ankhorage/utility/object';
import { isNonEmptyString } from '@ankhorage/utility/string';

import type { AppStoreConnectRuntime } from '../../../../utils/createAppStoreConnectRuntime.js';

const API = 'https://api.appstoreconnect.apple.com/v1';
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

interface ListingContext {
  readonly appInfoId: string;
  readonly versionId: string;
  readonly appInfo: readonly Resource[];
  readonly version: readonly Resource[];
}

interface Resource {
  readonly id: string;
  readonly locale: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

/*** Creates the App Store listing adapter for localized metadata and screenshots. */
export function createAppStoreConnectStoreListingAdapter(
  runtime: AppStoreConnectRuntime,
): DeploymentStoreListingAdapter {
  return {
    target: 'ios',
    inspectAsync: (context) => inspectAsync(context, runtime),
    syncAsync: (request) => syncAsync(request, runtime),
  };
}

/*** Inspects editable App Store metadata and screenshot checksums. */
async function inspectAsync(
  context: StoreListingAdapterContext,
  runtime: AppStoreConnectRuntime,
): Promise<DeploymentProviderResult<StoreListingTargetState>> {
  if (context.identity.target !== 'ios') return failed('APP_STORE_LISTING_IDENTITY_INVALID');
  const access = await runtime.resolveTokenAsync(context.credentials, context.resolveSecret);
  if (!access.ok) return { status: 'action-required', action: access.action };
  const resolved = await resolveContextAsync(
    context.identity.bundleIdentifier,
    access.token,
    runtime,
  );
  if (resolved === null) return editableRequired();
  const locales = mergeLocales(resolved.appInfo, resolved.version);
  const assetSets = await readAssetsAsync(resolved.version, access.token, runtime);
  if (assetSets === null) return failed('APP_STORE_LISTING_INSPECTION_FAILED');
  return {
    status: 'completed',
    value: {
      target: 'ios',
      locales,
      assetSets,
      supportedFields: SUPPORTED_FIELDS,
      diagnostics: [],
    },
  };
}

/*** Applies a provider-neutral listing plan through App Store Connect JSON:API. */
async function syncAsync(
  request: StoreListingSyncRequest,
  runtime: AppStoreConnectRuntime,
): Promise<DeploymentProviderResult<StoreListingTargetState>> {
  if (request.identity.target !== 'ios') return failed('APP_STORE_LISTING_IDENTITY_INVALID');
  if (request.plan.status === 'blocked') return failed('APP_STORE_LISTING_PLAN_BLOCKED');
  if (request.plan.status === 'no-change') return inspectAsync(request, runtime);
  const access = await runtime.resolveTokenAsync(request.credentials, request.resolveSecret);
  if (!access.ok) return { status: 'action-required', action: access.action };
  const context = await resolveContextAsync(
    request.identity.bundleIdentifier,
    access.token,
    runtime,
  );
  if (context === null) return editableRequired();
  for (const step of request.plan.steps) {
    if (step.target !== 'ios') continue;
    const ok =
      step.operation === 'replace-assets'
        ? await replaceAssetsAsync(
            request,
            context,
            step.locale,
            step.variant,
            access.token,
            runtime,
          )
        : await writeLocaleAsync(request, context, step.locale, access.token, runtime);
    if (!ok) return failed('APP_STORE_LISTING_SYNC_FAILED');
  }
  return inspectAsync(request, runtime);
}

/*** Resolves editable App Info and App Store Version localization containers. */
async function resolveContextAsync(
  bundleIdentifier: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<ListingContext | null> {
  const appId = await findAppIdAsync(bundleIdentifier, token, runtime);
  if (appId === null) return null;
  const [infos, versions] = await Promise.all([
    readCollectionAsync(
      `${API}/apps/${encodeURIComponent(appId)}/appInfos?limit=200`,
      token,
      runtime,
    ),
    readCollectionAsync(
      `${API}/apps/${encodeURIComponent(appId)}/appStoreVersions?filter[platform]=IOS&limit=200`,
      token,
      runtime,
    ),
  ]);
  const appInfoId = findEditableId(infos, 'appInfos');
  const versionId = findEditableId(versions, 'appStoreVersions');
  if (appInfoId === null || versionId === null) return null;
  const [appInfo, version] = await Promise.all([
    readLocalizationsAsync(
      `${API}/appInfos/${encodeURIComponent(appInfoId)}/appInfoLocalizations?limit=200`,
      token,
      runtime,
    ),
    readLocalizationsAsync(
      `${API}/appStoreVersions/${encodeURIComponent(versionId)}/appStoreVersionLocalizations?limit=200`,
      token,
      runtime,
    ),
  ]);
  return appInfo === null || version === null ? null : { appInfoId, versionId, appInfo, version };
}

/*** Finds the App Store app matching one bundle identifier. */
async function findAppIdAsync(
  bundleIdentifier: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<string | null> {
  const query = new URLSearchParams({ 'filter[bundleId]': bundleIdentifier, limit: '2' });
  const values = await readCollectionAsync(`${API}/apps?${query.toString()}`, token, runtime);
  const matches = values.filter(
    (item) =>
      isRecord(item) &&
      isNonEmptyString(item.id) &&
      isRecord(item.attributes) &&
      item.attributes.bundleId === bundleIdentifier,
  );
  return matches.length === 1 && isRecord(matches[0]) && isNonEmptyString(matches[0].id)
    ? matches[0].id
    : null;
}

/*** Finds one editable App Store resource id from a collection. */
function findEditableId(values: readonly unknown[], type: string): string | null {
  const candidates = values.filter(
    (value) =>
      isRecord(value) &&
      value.type === type &&
      isNonEmptyString(value.id) &&
      (!isRecord(value.attributes) ||
        isEditable(value.attributes.appVersionState ?? value.attributes.state)),
  );
  return candidates.length > 0 && isRecord(candidates[0]) && isNonEmptyString(candidates[0].id)
    ? candidates[0].id
    : null;
}

/*** Determines whether App Store metadata can still be edited. */
function isEditable(value: unknown): boolean {
  return (
    value === undefined ||
    [
      'PREPARE_FOR_SUBMISSION',
      'READY_FOR_REVIEW',
      'INVALID_BINARY',
      'REJECTED',
      'METADATA_REJECTED',
      'DEVELOPER_REJECTED',
    ].includes(String(value))
  );
}

/*** Reads localization resources from one App Store Connect collection. */
async function readLocalizationsAsync(
  url: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<readonly Resource[] | null> {
  const values = await readCollectionAsync(url, token, runtime);
  const parsed = values.map((value) => {
    if (!isRecord(value) || !isNonEmptyString(value.id) || !isRecord(value.attributes)) return null;
    return isNonEmptyString(value.attributes.locale)
      ? { id: value.id, locale: value.attributes.locale, attributes: value.attributes }
      : null;
  });
  return parsed.every((value): value is Resource => value !== null) ? parsed : null;
}

/*** Merges App Info and version localization layers into portable listing locales. */
function mergeLocales(
  appInfo: readonly Resource[],
  version: readonly Resource[],
): readonly StoreListingLocale[] {
  const locales = [...new Set([...appInfo, ...version].map((item) => item.locale))].sort();
  return locales.map((locale) => {
    const info = appInfo.find((item) => item.locale === locale)?.attributes;
    const ver = version.find((item) => item.locale === locale)?.attributes;
    const summary = readString(info?.subtitle);
    const privacyPolicyUrl = readString(info?.privacyPolicyUrl);
    const description = readString(ver?.description);
    const keywords = readString(ver?.keywords);
    const promotionalText = readString(ver?.promotionalText);
    const supportUrl = readString(ver?.supportUrl);
    const marketingUrl = readString(ver?.marketingUrl);
    return {
      locale,
      name: readString(info?.name) ?? locale,
      ...(summary === undefined ? {} : { summary }),
      ...(privacyPolicyUrl === undefined ? {} : { privacyPolicyUrl }),
      ...(description === undefined ? {} : { description }),
      ...(keywords === undefined
        ? {}
        : {
            keywords: keywords
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean),
          }),
      ...(promotionalText === undefined ? {} : { promotionalText }),
      ...(supportUrl === undefined ? {} : { supportUrl }),
      ...(marketingUrl === undefined ? {} : { marketingUrl }),
    };
  });
}

/*** Reads screenshot sets and their uploaded asset checksums. */
async function readAssetsAsync(
  version: readonly Resource[],
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<readonly StoreListingRemoteAssetSet[] | null> {
  const results = await Promise.all(
    version.flatMap((localization) => readScreenshotSetsAsync(localization, token, runtime)),
  );
  return results.some((value) => value === null) ? null : results.flatMap((value) => value ?? []);
}

/*** Reads all screenshot sets for one version localization. */
async function readScreenshotSetsAsync(
  localization: Resource,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<readonly StoreListingRemoteAssetSet[] | null> {
  const sets = await readCollectionAsync(
    `${API}/appStoreVersionLocalizations/${encodeURIComponent(localization.id)}/appScreenshotSets?limit=200`,
    token,
    runtime,
  );
  const values = await Promise.all(
    sets.map(async (set) => {
      if (!isRecord(set) || !isNonEmptyString(set.id) || !isRecord(set.attributes)) return null;
      if (!isNonEmptyString(set.attributes.screenshotDisplayType)) return null;
      const screenshots = await readCollectionAsync(
        `${API}/appScreenshotSets/${encodeURIComponent(set.id)}/appScreenshots?limit=200`,
        token,
        runtime,
      );
      const hashes = screenshots.flatMap((shot) =>
        isRecord(shot) &&
        isRecord(shot.attributes) &&
        isNonEmptyString(shot.attributes.sourceFileChecksum)
          ? [shot.attributes.sourceFileChecksum]
          : [],
      );
      return {
        target: 'ios' as const,
        locale: localization.locale,
        variant: set.attributes.screenshotDisplayType,
        checksum: 'md5' as const,
        hashes,
      };
    }),
  );
  return values.some((value) => value === null) ? null : values.filter((value) => value !== null);
}

/*** Writes App Info and version localization metadata for one locale. */
async function writeLocaleAsync(
  request: StoreListingSyncRequest,
  context: ListingContext,
  locale: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<boolean> {
  const desired = request.desired.locales.find((item) => item.locale === locale);
  if (desired === undefined) return false;
  const info = context.appInfo.find((item) => item.locale === locale);
  const version = context.version.find((item) => item.locale === locale);
  const infoBody = {
    name: desired.name,
    ...(desired.summary === undefined ? {} : { subtitle: desired.summary }),
    ...(desired.privacyPolicyUrl === undefined
      ? {}
      : { privacyPolicyUrl: desired.privacyPolicyUrl }),
  };
  const versionBody = {
    ...(desired.description === undefined ? {} : { description: desired.description }),
    ...(desired.keywords === undefined ? {} : { keywords: desired.keywords.join(',') }),
    ...(desired.promotionalText === undefined ? {} : { promotionalText: desired.promotionalText }),
    ...(desired.supportUrl === undefined ? {} : { supportUrl: desired.supportUrl }),
    ...(desired.marketingUrl === undefined ? {} : { marketingUrl: desired.marketingUrl }),
  };
  const writes = await Promise.all([
    writeLocalizationAsync(
      'appInfoLocalizations',
      info?.id,
      context.appInfoId,
      locale,
      infoBody,
      token,
      runtime,
    ),
    writeLocalizationAsync(
      'appStoreVersionLocalizations',
      version?.id,
      context.versionId,
      locale,
      versionBody,
      token,
      runtime,
    ),
  ]);
  return writes.every(Boolean);
}

/*** Creates or patches one App Store localization resource. */
async function writeLocalizationAsync(
  type: 'appInfoLocalizations' | 'appStoreVersionLocalizations',
  id: string | undefined,
  ownerId: string,
  locale: string,
  attributes: Readonly<Record<string, unknown>>,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<boolean> {
  const relationship = type === 'appInfoLocalizations' ? 'appInfo' : 'appStoreVersion';
  const response = await safeRequestAsync(runtime, {
    method: id === undefined ? 'POST' : 'PATCH',
    url: id === undefined ? `${API}/${type}` : `${API}/${type}/${encodeURIComponent(id)}`,
    token,
    body: JSON.stringify({
      data: {
        type,
        ...(id === undefined ? {} : { id }),
        attributes: { locale, ...attributes },
        ...(id === undefined
          ? {
              relationships: {
                [relationship]: { data: { type: `${relationship}s`, id: ownerId } },
              },
            }
          : {}),
      },
    }),
  });
  return response !== null && isSuccess(response.status);
}

/*** Replaces one App Store screenshot set from desired asset bytes. */
async function replaceAssetsAsync(
  request: StoreListingSyncRequest,
  context: ListingContext,
  locale: string,
  variant: string | undefined,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<boolean> {
  if (variant === undefined) return false;
  const localization = context.version.find((item) => item.locale === locale);
  const desired = request.desired.assetSets.find(
    (item) => item.target === 'ios' && item.locale === locale && item.variant === variant,
  );
  if (localization === undefined || desired === undefined) return false;
  const setId = await ensureScreenshotSetAsync(localization.id, variant, token, runtime);
  if (setId === null) return false;
  const existing = await readCollectionAsync(
    `${API}/appScreenshotSets/${encodeURIComponent(setId)}/appScreenshots?limit=200`,
    token,
    runtime,
  );
  const deleted = await Promise.all(
    existing.flatMap((item) =>
      isRecord(item) && isNonEmptyString(item.id)
        ? [
            safeRequestAsync(runtime, {
              method: 'DELETE',
              url: `${API}/appScreenshots/${encodeURIComponent(item.id)}`,
              token,
            }),
          ]
        : [],
    ),
  );
  if (!deleted.every((response) => response !== null && isSuccess(response.status))) return false;
  for (const asset of desired.assets) {
    const bytes = await request.assets.readAsync(asset.relativePath);
    if (!(await uploadScreenshotAsync(setId, asset.relativePath, bytes, token, runtime)))
      return false;
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
  const values = await readCollectionAsync(
    `${API}/appStoreVersionLocalizations/${encodeURIComponent(localizationId)}/appScreenshotSets?limit=200`,
    token,
    runtime,
  );
  const existing = values.find(
    (item) =>
      isRecord(item) &&
      isRecord(item.attributes) &&
      item.attributes.screenshotDisplayType === variant,
  );
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

/*** Reserves, uploads, and commits one screenshot asset. */
async function uploadScreenshotAsync(
  setId: string,
  fileName: string,
  bytes: Uint8Array,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<boolean> {
  const reserved = await safeRequestAsync(runtime, {
    method: 'POST',
    url: `${API}/appScreenshots`,
    token,
    body: JSON.stringify({
      data: {
        type: 'appScreenshots',
        attributes: { fileName, fileSize: bytes.byteLength },
        relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: setId } } },
      },
    }),
  });
  if (reserved?.status !== 201) return false;
  const value = parseJson(reserved.body);
  if (!isRecord(value) || !isRecord(value.data) || !isNonEmptyString(value.data.id)) return false;
  if (!isRecord(value.data.attributes) || !Array.isArray(value.data.attributes.uploadOperations))
    return false;
  const statuses = await Promise.all(
    value.data.attributes.uploadOperations.flatMap((operation) => {
      if (
        !isRecord(operation) ||
        typeof operation.offset !== 'number' ||
        typeof operation.length !== 'number'
      )
        return [];
      if (!isNonEmptyString(operation.method) || !isNonEmptyString(operation.url)) return [];
      const headers = Array.isArray(operation.requestHeaders)
        ? operation.requestHeaders.flatMap((header) =>
            isRecord(header) && isNonEmptyString(header.name) && typeof header.value === 'string'
              ? [{ name: header.name, value: header.value }]
              : [],
          )
        : [];
      return [
        runtime.upload({
          method: operation.method,
          url: operation.url,
          headers,
          body: bytes.slice(operation.offset, operation.offset + operation.length),
        }),
      ];
    }),
  );
  if (!statuses.every(isSuccess)) return false;
  const committed = await safeRequestAsync(runtime, {
    method: 'PATCH',
    url: `${API}/appScreenshots/${encodeURIComponent(value.data.id)}`,
    token,
    body: JSON.stringify({
      data: { type: 'appScreenshots', id: value.data.id, attributes: { uploaded: true } },
    }),
  });
  return committed !== null && isSuccess(committed.status);
}

/*** Reads one JSON:API collection as unknown values. */
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
): Promise<Awaited<ReturnType<AppStoreConnectRuntime['request']>> | null> {
  try {
    return await runtime.request(request);
  } catch {
    return null;
  }
}

/*** Reads a JSON:API resource id. */
function readResourceId(body: string, type: string): string | null {
  const value = parseJson(body);
  return isRecord(value) &&
    isRecord(value.data) &&
    value.data.type === type &&
    isNonEmptyString(value.data.id)
    ? value.data.id
    : null;
}

/*** Parses JSON without exposing parser exceptions. */
function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

/*** Reads a string property defensively. */
function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/*** Tests whether an HTTP status code is successful. */
function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
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
