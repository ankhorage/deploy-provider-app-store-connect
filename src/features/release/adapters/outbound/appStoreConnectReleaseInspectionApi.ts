import type { ReleaseNote } from '@ankhorage/contracts/deploy-provider';
import { isRecord } from '@ankhorage/utility/object';
import { isNonEmptyString } from '@ankhorage/utility/string';

import type {
  AppStorePhasedReleaseState,
  AppStoreReleaseContext,
  AppStoreReviewState,
} from '../../../../types/appStoreConnectRelease.js';
import type { AppStoreConnectRuntime } from '../../../../utils/createAppStoreConnectRuntime.js';
import { findAppStoreConnectAppIdAsync } from '../../../../utils/findAppStoreConnectAppIdAsync.js';

const API = 'https://api.appstoreconnect.apple.com/v1';

export interface AppStoreConnectReleaseInspectionApi {
  resolveContextAsync(
    bundleIdentifier: string,
    version: string,
    token: string,
  ): Promise<AppStoreReleaseContext | null>;
  readNotesAsync(versionId: string, token: string): Promise<readonly ReleaseNote[]>;
  readBuildNumberAsync(versionId: string, token: string): Promise<string | null>;
  readReviewAsync(appId: string, versionId: string, token: string): Promise<AppStoreReviewState>;
  readPhasedAsync(versionId: string, token: string): Promise<AppStorePhasedReleaseState>;
}

/*** Creates App Store Connect operations used to inspect release state. */
export function createAppStoreConnectReleaseInspectionApi(
  runtime: AppStoreConnectRuntime,
): AppStoreConnectReleaseInspectionApi {
  return {
    resolveContextAsync: (bundleIdentifier, version, token) =>
      resolveContextAsync(bundleIdentifier, version, token, runtime),
    readNotesAsync: (versionId, token) => readNotesAsync(versionId, token, runtime),
    readBuildNumberAsync: (versionId, token) => readBuildNumberAsync(versionId, token, runtime),
    readReviewAsync: (appId, versionId, token) =>
      readReviewAsync(appId, versionId, token, runtime),
    readPhasedAsync: (versionId, token) => readPhasedAsync(versionId, token, runtime),
  };
}

/*** Resolves the App Store version resource for a bundle identifier and version string. */
async function resolveContextAsync(
  bundleIdentifier: string,
  version: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<AppStoreReleaseContext | null> {
  const appId = await findAppStoreConnectAppIdAsync(bundleIdentifier, token, runtime);
  if (appId === null) return null;
  const versions = await readCollectionAsync(
    `${API}/apps/${encodeURIComponent(appId)}/appStoreVersions?filter[platform]=IOS&limit=200`,
    token,
    runtime,
  );
  if (versions === null) return null;
  const item = versions.find((value) => matchesVersion(value, version));
  return isRecord(item) && isNonEmptyString(item.id)
    ? { appId, versionId: item.id, version: item }
    : null;
}

/*** Checks whether a JSON:API version resource matches the requested version. */
function matchesVersion(value: unknown, version: string): boolean {
  return (
    isRecord(value) &&
    isRecord(value.attributes) &&
    value.attributes.versionString === version
  );
}

/*** Reads localized what's-new notes for one App Store version. */
async function readNotesAsync(
  versionId: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<readonly ReleaseNote[]> {
  const values = await readCollectionAsync(
    `${API}/appStoreVersions/${encodeURIComponent(versionId)}/appStoreVersionLocalizations?limit=200`,
    token,
    runtime,
  );
  if (values === null) return [];
  return values.flatMap((value) => {
    if (!isRecord(value) || !isRecord(value.attributes)) return [];
    const { locale, whatsNew } = value.attributes;
    return isNonEmptyString(locale) && typeof whatsNew === 'string'
      ? [{ locale, text: whatsNew }]
      : [];
  });
}

/*** Reads the build number attached to one App Store version. */
async function readBuildNumberAsync(
  versionId: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<string | null> {
  const response = await safeRequestAsync(runtime, {
    method: 'GET',
    url: `${API}/appStoreVersions/${encodeURIComponent(versionId)}/build?fields[builds]=version`,
    token,
  });
  if (response === null || !isSuccess(response.status)) return null;
  const resource = parseResource(response.body);
  return resource !== null &&
    isRecord(resource.attributes) &&
    isNonEmptyString(resource.attributes.version)
    ? resource.attributes.version
    : null;
}

/*** Reads the review submission associated with one App Store version. */
async function readReviewAsync(
  appId: string,
  versionId: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<AppStoreReviewState> {
  const values = await readCollectionAsync(
    `${API}/apps/${encodeURIComponent(appId)}/reviewSubmissions?include=appStoreVersionForReview&limit=200`,
    token,
    runtime,
  );
  if (values === null) return {};
  const match = values.find((value) => reviewMatchesVersion(value, versionId));
  if (!isRecord(match)) return {};
  return {
    ...(isNonEmptyString(match.id) ? { id: match.id } : {}),
    ...(isRecord(match.attributes) && typeof match.attributes.state === 'string'
      ? { state: match.attributes.state }
      : {}),
  };
}

/*** Checks whether one review submission references the requested App Store version. */
function reviewMatchesVersion(value: unknown, versionId: string): boolean {
  if (!isRecord(value) || !isRecord(value.relationships)) return false;
  if (!isRecord(value.relationships.appStoreVersionForReview)) return false;
  const data = value.relationships.appStoreVersionForReview.data;
  return isRecord(data) && data.id === versionId;
}

/*** Reads the phased-release resource and portable state. */
async function readPhasedAsync(
  versionId: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<AppStorePhasedReleaseState> {
  const response = await safeRequestAsync(runtime, {
    method: 'GET',
    url: `${API}/appStoreVersions/${encodeURIComponent(versionId)}/appStoreVersionPhasedRelease`,
    token,
  });
  if (response === null || response.status === 404) return { state: null };
  if (!isSuccess(response.status)) return { state: null };
  const resource = parseResource(response.body);
  if (resource === null) return { state: null };
  const state = isRecord(resource.attributes) ? resource.attributes.phasedReleaseState : undefined;
  return {
    ...(isNonEmptyString(resource.id) ? { id: resource.id } : {}),
    state: normalizePhasedState(state),
  };
}

/*** Normalizes an App Store phased-release state to the portable contract. */
function normalizePhasedState(
  value: unknown,
): AppStorePhasedReleaseState['state'] {
  return value === 'INACTIVE' || value === 'ACTIVE' || value === 'PAUSED' || value === 'COMPLETE'
    ? value
    : null;
}

/*** Reads one JSON:API collection while preserving request failures. */
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

/*** Reads one JSON:API resource from a response body. */
function parseResource(body: string): Record<string, unknown> | null {
  const root = parseJson(body);
  return isRecord(root) && isRecord(root.data) ? root.data : null;
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
