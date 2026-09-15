import { isRecord } from '@ankhorage/utility/object';
import { isNonEmptyString } from '@ankhorage/utility/string';

import type { AppStoreConnectRuntime } from '../../../../utils/createAppStoreConnectRuntime.js';
import { createAppStoreConnectIosBuildUploadApi } from './appStoreConnectIosBuildUploadApi.js';

const API = 'https://api.appstoreconnect.apple.com/v1';

export interface AppStoreConnectIosPublicationApi {
  findAppIdAsync(bundleIdentifier: string, token: string): Promise<string | null>;
  readVersionAsync(
    appId: string,
    version: string,
    token: string,
  ): Promise<{ readonly version: string; readonly buildNumber: string | null } | null | undefined>;
  uploadBuildAsync(options: {
    readonly appId: string;
    readonly version: string;
    readonly buildNumber: string;
    readonly archive: Uint8Array;
    readonly token: string;
  }): Promise<string | null>;
  ensureVersionAsync(appId: string, version: string, token: string): Promise<string | null>;
  attachBuildAsync(versionId: string, buildId: string, token: string): Promise<boolean>;
}

/*** Creates App Store Connect API operations required for iOS publication. */
export function createAppStoreConnectIosPublicationApi(
  runtime: AppStoreConnectRuntime,
): AppStoreConnectIosPublicationApi {
  const upload = createAppStoreConnectIosBuildUploadApi(runtime);
  return {
    findAppIdAsync: (bundleIdentifier, token) => findAppIdAsync(bundleIdentifier, token, runtime),
    readVersionAsync: (appId, version, token) => readVersionAsync(appId, version, token, runtime),
    uploadBuildAsync: (options) => upload.uploadBuildAsync(options),
    ensureVersionAsync: (appId, version, token) =>
      ensureVersionAsync(appId, version, token, runtime),
    attachBuildAsync: (versionId, buildId, token) =>
      attachBuildAsync(versionId, buildId, token, runtime),
  };
}

/*** Resolves the unique App Store app id for one bundle identifier. */
async function findAppIdAsync(
  bundleIdentifier: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<string | null> {
  const query = new URLSearchParams({
    'filter[bundleId]': bundleIdentifier,
    'fields[apps]': 'bundleId',
    limit: '2',
  });
  const response = await safeRequestAsync(runtime, {
    method: 'GET',
    url: `${API}/apps?${query.toString()}`,
    token,
  });
  if (response === null || !isSuccess(response.status)) return null;
  const root = parseJson(response.body);
  const data = isRecord(root) ? unknownArray(root.data) : [];
  const matches = data.filter((item) => matchesApp(item, bundleIdentifier));
  const match = matches.length === 1 ? matches.at(0) : undefined;
  return isRecord(match) && isNonEmptyString(match.id) ? match.id : null;
}

/*** Checks whether one JSON:API resource matches the expected bundle identifier. */
function matchesApp(value: unknown, bundleIdentifier: string): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isRecord(value.attributes) &&
    value.attributes.bundleId === bundleIdentifier
  );
}

/*** Reads one App Store version and its included build. */
async function readVersionAsync(
  appId: string,
  version: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<{ readonly version: string; readonly buildNumber: string | null } | null | undefined> {
  const query = new URLSearchParams({
    'filter[platform]': 'IOS',
    'fields[appStoreVersions]': 'platform,versionString,build',
    'fields[builds]': 'version,processingState',
    include: 'build',
    limit: '200',
  });
  const response = await safeRequestAsync(runtime, {
    method: 'GET',
    url: `${API}/apps/${encodeURIComponent(appId)}/appStoreVersions?${query.toString()}`,
    token,
  });
  if (response === null || !isSuccess(response.status)) return undefined;
  const root = parseJson(response.body);
  if (!isRecord(root)) return undefined;
  const match = unknownArray(root.data).find((item) => matchesVersion(item, version));
  if (match === undefined) return null;
  if (!isRecord(match)) return undefined;
  const buildId = readBuildRelationshipId(match);
  if (buildId === null) return { version, buildNumber: null };
  const build = unknownArray(root.included).find(
    (item) => isRecord(item) && item.type === 'builds' && item.id === buildId,
  );
  return isRecord(build) && isRecord(build.attributes) && isNonEmptyString(build.attributes.version)
    ? { version, buildNumber: build.attributes.version }
    : undefined;
}

/*** Checks whether one resource is the requested iOS App Store version. */
function matchesVersion(value: unknown, version: string): boolean {
  return (
    isRecord(value) &&
    isRecord(value.attributes) &&
    value.attributes.platform === 'IOS' &&
    value.attributes.versionString === version
  );
}

/*** Reads the build relationship id without dynamic property access. */
function readBuildRelationshipId(value: Readonly<Record<string, unknown>>): string | null {
  if (!isRecord(value.relationships) || !isRecord(value.relationships.build)) return null;
  const { data } = value.relationships.build;
  return isRecord(data) && data.type === 'builds' && isNonEmptyString(data.id) ? data.id : null;
}

/*** Finds or creates an App Store version. */
async function ensureVersionAsync(
  appId: string,
  version: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<string | null> {
  const existing = await findVersionIdAsync(appId, version, token, runtime);
  if (existing !== undefined) return existing;
  const response = await safeRequestAsync(runtime, {
    method: 'POST',
    url: `${API}/appStoreVersions`,
    token,
    body: JSON.stringify({
      data: {
        type: 'appStoreVersions',
        attributes: { platform: 'IOS', versionString: version, releaseType: 'MANUAL' },
        relationships: { app: { data: { type: 'apps', id: appId } } },
      },
    }),
  });
  return response?.status === 201 ? readResourceId(response.body, 'appStoreVersions') : null;
}

/*** Finds an existing App Store version id. */
async function findVersionIdAsync(
  appId: string,
  version: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<string | null | undefined> {
  const response = await safeRequestAsync(runtime, {
    method: 'GET',
    url: `${API}/apps/${encodeURIComponent(appId)}/appStoreVersions?filter[platform]=IOS&limit=200`,
    token,
  });
  if (response === null || !isSuccess(response.status)) return null;
  const root = parseJson(response.body);
  const matches = isRecord(root)
    ? unknownArray(root.data).filter((item) => matchesVersion(item, version))
    : [];
  if (matches.length === 0) return undefined;
  const match = matches.length === 1 ? matches.at(0) : undefined;
  return isRecord(match) && isNonEmptyString(match.id) ? match.id : null;
}

/*** Attaches a processed build to one App Store version. */
async function attachBuildAsync(
  versionId: string,
  buildId: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<boolean> {
  const response = await safeRequestAsync(runtime, {
    method: 'PATCH',
    url: `${API}/appStoreVersions/${encodeURIComponent(versionId)}/relationships/build`,
    token,
    body: JSON.stringify({ data: { type: 'builds', id: buildId } }),
  });
  return response !== null && isSuccess(response.status);
}

/*** Executes one App Store Connect request while containing transport errors. */
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
