import type { StoreListingLocale } from '@ankhorage/contracts/deploy-provider';
import { isRecord } from '@ankhorage/utility/object';
import { isNonEmptyString } from '@ankhorage/utility/string';

import type { AppStoreListingContext, AppStoreListingResource } from '../../../../types/appStoreConnectListing.js';
import type { AppStoreConnectRuntime } from '../../../../utils/createAppStoreConnectRuntime.js';
import { findAppStoreConnectAppIdAsync } from '../../../../utils/findAppStoreConnectAppIdAsync.js';

const API = 'https://api.appstoreconnect.apple.com/v1';

export interface AppStoreConnectListingMetadataApi {
  resolveContextAsync(bundleIdentifier: string, token: string): Promise<AppStoreListingContext | null>;
  writeLocaleAsync(
    context: AppStoreListingContext,
    desired: StoreListingLocale,
    token: string,
  ): Promise<boolean>;
}

/*** Creates App Store Connect operations for editable listing metadata. */
export function createAppStoreConnectListingMetadataApi(
  runtime: AppStoreConnectRuntime,
): AppStoreConnectListingMetadataApi {
  return {
    resolveContextAsync: (bundleIdentifier, token) =>
      resolveContextAsync(bundleIdentifier, token, runtime),
    writeLocaleAsync: (context, desired, token) =>
      writeLocaleAsync(context, desired, token, runtime),
  };
}

/*** Resolves editable App Info and App Store Version localization containers. */
async function resolveContextAsync(
  bundleIdentifier: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<AppStoreListingContext | null> {
  const appId = await findAppStoreConnectAppIdAsync(bundleIdentifier, token, runtime);
  if (appId === null) return null;
  const [infos, versions] = await Promise.all([
    readCollectionAsync(`${API}/apps/${encodeURIComponent(appId)}/appInfos?limit=200`, token, runtime),
    readCollectionAsync(
      `${API}/apps/${encodeURIComponent(appId)}/appStoreVersions?filter[platform]=IOS&limit=200`,
      token,
      runtime,
    ),
  ]);
  if (infos === null || versions === null) return null;
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

/*** Finds one editable App Store resource id. */
function findEditableId(values: readonly unknown[], type: string): string | null {
  const candidates = values.filter((value) => isEditableResource(value, type));
  const candidate = candidates.at(0);
  return isRecord(candidate) && isNonEmptyString(candidate.id) ? candidate.id : null;
}

/*** Checks whether a provider resource can still be edited. */
function isEditableResource(value: unknown, type: string): boolean {
  if (!isRecord(value) || value.type !== type || !isNonEmptyString(value.id)) return false;
  if (!isRecord(value.attributes)) return true;
  const state = value.attributes.appVersionState ?? value.attributes.state;
  if (state === undefined) return true;
  return (
    state === 'PREPARE_FOR_SUBMISSION' ||
    state === 'READY_FOR_REVIEW' ||
    state === 'INVALID_BINARY' ||
    state === 'REJECTED' ||
    state === 'METADATA_REJECTED' ||
    state === 'DEVELOPER_REJECTED'
  );
}

/*** Reads localization resources from one JSON:API collection. */
async function readLocalizationsAsync(
  url: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<readonly AppStoreListingResource[] | null> {
  const values = await readCollectionAsync(url, token, runtime);
  if (values === null) return null;
  const parsed = values.map(parseLocalization);
  return parsed.every((value) => value !== null)
    ? parsed.filter((value) => value !== null)
    : null;
}

/*** Parses one App Store localization resource. */
function parseLocalization(value: unknown): AppStoreListingResource | null {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isRecord(value.attributes)) return null;
  return isNonEmptyString(value.attributes.locale)
    ? { id: value.id, locale: value.attributes.locale, attributes: value.attributes }
    : null;
}

/*** Writes App Info and version localization metadata for one locale. */
async function writeLocaleAsync(
  context: AppStoreListingContext,
  desired: StoreListingLocale,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<boolean> {
  const info = context.appInfo.find((item) => item.locale === desired.locale);
  const version = context.version.find((item) => item.locale === desired.locale);
  const writes = await Promise.all([
    writeLocalizationAsync({
      type: 'appInfoLocalizations',
      ownerType: 'appInfos',
      ownerId: context.appInfoId,
      id: info?.id,
      locale: desired.locale,
      attributes: {
        name: desired.name,
        ...(desired.summary === undefined ? {} : { subtitle: desired.summary }),
        ...(desired.privacyPolicyUrl === undefined ? {} : { privacyPolicyUrl: desired.privacyPolicyUrl }),
      },
      token,
      runtime,
    }),
    writeLocalizationAsync({
      type: 'appStoreVersionLocalizations',
      ownerType: 'appStoreVersions',
      ownerId: context.versionId,
      id: version?.id,
      locale: desired.locale,
      attributes: {
        ...(desired.description === undefined ? {} : { description: desired.description }),
        ...(desired.keywords === undefined ? {} : { keywords: desired.keywords.join(',') }),
        ...(desired.promotionalText === undefined ? {} : { promotionalText: desired.promotionalText }),
        ...(desired.supportUrl === undefined ? {} : { supportUrl: desired.supportUrl }),
        ...(desired.marketingUrl === undefined ? {} : { marketingUrl: desired.marketingUrl }),
      },
      token,
      runtime,
    }),
  ]);
  return writes.every(Boolean);
}

/*** Creates or patches one App Store listing localization. */
async function writeLocalizationAsync(options: {
  readonly type: 'appInfoLocalizations' | 'appStoreVersionLocalizations';
  readonly ownerType: 'appInfos' | 'appStoreVersions';
  readonly ownerId: string;
  readonly id?: string;
  readonly locale: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly token: string;
  readonly runtime: AppStoreConnectRuntime;
}): Promise<boolean> {
  const response = await safeRequestAsync(options.runtime, {
    method: options.id === undefined ? 'POST' : 'PATCH',
    url:
      options.id === undefined
        ? `${API}/${options.type}`
        : `${API}/${options.type}/${encodeURIComponent(options.id)}`,
    token: options.token,
    body: JSON.stringify({
      data: {
        type: options.type,
        ...(options.id === undefined ? {} : { id: options.id }),
        attributes: { locale: options.locale, ...options.attributes },
        ...(options.id === undefined
          ? {
              relationships: {
                owner: { data: { type: options.ownerType, id: options.ownerId } },
              },
            }
          : {}),
      },
    }),
  });
  return response !== null && isSuccess(response.status);
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
  return isRecord(root) && Array.isArray(root.data)
    ? root.data.map((item: unknown) => item)
    : null;
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
