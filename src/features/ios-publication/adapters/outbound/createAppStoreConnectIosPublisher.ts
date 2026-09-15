import type {
  DeploymentProviderResult,
  IosDeploymentPublication,
  IosDeploymentPublisher,
  IosPublishInspection,
  IosPublishInspectionRequest,
  IosPublishRequest,
} from '@ankhorage/contracts/deploy-provider';
import { isRecord } from '@ankhorage/utility/object';
import { isNonEmptyString } from '@ankhorage/utility/string';

import type { AppStoreConnectRuntime } from '../../../../utils/createAppStoreConnectRuntime.js';

const API = 'https://api.appstoreconnect.apple.com/v1';

interface UploadOperation {
  readonly offset: number;
  readonly length: number;
  readonly method: string;
  readonly url: string;
  readonly headers: readonly { readonly name: string; readonly value: string }[];
}

/*** Creates the iOS App Store Connect publisher, inspector, and verifier. */
export function createAppStoreConnectIosPublisher(
  runtime: AppStoreConnectRuntime,
): IosDeploymentPublisher {
  return {
    inspectAsync: (request) => inspectAsync(request, runtime),
    publishAsync: (request) => publishAsync(request, runtime),
    verifyAsync: (request) => verifyAsync(request, runtime),
  };
}

/*** Inspects the App Store version and attached build for one bundle identifier. */
async function inspectAsync(
  request: IosPublishInspectionRequest,
  runtime: AppStoreConnectRuntime,
): Promise<DeploymentProviderResult<IosPublishInspection>> {
  const access = await runtime.resolveTokenAsync(request.credentials, request.resolveSecret);
  if (!access.ok) return { status: 'action-required', action: access.action };
  const appId = await findAppIdAsync(request.bundleIdentifier, access.token, runtime);
  if (appId === null) return appRequired();
  const version = await readVersionAsync(appId, request.version, access.token, runtime);
  if (version === undefined) return failedInspection('APP_STORE_CONNECT_RESPONSE_INVALID');
  return {
    status: 'completed',
    value: {
      bundleIdentifier: request.bundleIdentifier,
      version: version?.version ?? null,
      buildNumber: version?.buildNumber ?? null,
    },
  };
}

/*** Publishes an iOS artifact through Apple's build-upload API and attaches it to the version. */
async function publishAsync(
  request: IosPublishRequest,
  runtime: AppStoreConnectRuntime,
): Promise<DeploymentProviderResult<IosDeploymentPublication>> {
  const access = await runtime.resolveTokenAsync(request.credentials, request.resolveSecret);
  if (!access.ok) return { status: 'action-required', action: access.action };
  const appId = await findAppIdAsync(request.bundleIdentifier, access.token, runtime);
  if (appId === null) return publicationAction('APP_STORE_APP_REQUIRED');
  const archive = await runtime.downloadArtifact(request.artifact.archiveUrl);
  if (archive === null) return failedPublication('IOS_ARCHIVE_DOWNLOAD_FAILED');
  const buildId = await uploadBuildAsync(request, appId, access.token, archive, runtime);
  if (buildId === null) return failedPublication('APP_STORE_BUILD_UPLOAD_FAILED');
  const versionId = await ensureVersionAsync(appId, request.version, access.token, runtime);
  if (versionId === null) return failedPublication('APP_STORE_VERSION_PREPARATION_FAILED');
  if (!(await attachBuildAsync(versionId, buildId, access.token, runtime)))
    return failedPublication('APP_STORE_VERSION_BUILD_ATTACH_FAILED');
  return {
    status: 'completed',
    value: {
      target: 'ios',
      revision: request.revision,
      buildProvider: request.artifact.provider,
      publishProvider: 'app-store-connect',
      buildId: request.artifact.buildId,
      version: request.version,
      buildNumber: request.artifact.buildNumber,
    },
  };
}

/*** Verifies that the expected App Store version is attached to the published build number. */
async function verifyAsync(
  request: IosPublishRequest,
  runtime: AppStoreConnectRuntime,
): Promise<DeploymentProviderResult<IosPublishInspection>> {
  const inspection = await inspectAsync(request, runtime);
  if (inspection.status !== 'completed') return inspection;
  return inspection.value.version === request.version &&
    inspection.value.buildNumber === request.artifact.buildNumber
    ? inspection
    : failedInspection('APP_STORE_CONNECT_VERIFICATION_FAILED');
}

/*** Resolves the unique App Store app id for a bundle identifier. */
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
  const value = parseJson(response.body);
  if (!isRecord(value) || !Array.isArray(value.data)) return null;
  const matches = value.data.filter(
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

/*** Reads one version and its included build, returning null when the version does not exist. */
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
  const value = parseJson(response.body);
  if (!isRecord(value) || !Array.isArray(value.data)) return undefined;
  const match = value.data.find(
    (item) =>
      isRecord(item) &&
      isRecord(item.attributes) &&
      item.attributes.platform === 'IOS' &&
      item.attributes.versionString === version,
  );
  if (match === undefined) return null;
  if (!isRecord(match)) return undefined;
  const buildId = readRelationshipId(match.relationships, 'build', 'builds');
  if (buildId === null) return { version, buildNumber: null };
  const build = Array.isArray(value.included)
    ? value.included.find((item) => isRecord(item) && item.type === 'builds' && item.id === buildId)
    : undefined;
  return isRecord(build) && isRecord(build.attributes) && isNonEmptyString(build.attributes.version)
    ? { version, buildNumber: build.attributes.version }
    : undefined;
}

/*** Uploads an IPA and waits until App Store Connect exposes its processed build. */
async function uploadBuildAsync(
  request: IosPublishRequest,
  appId: string,
  token: string,
  archive: Uint8Array,
  runtime: AppStoreConnectRuntime,
): Promise<string | null> {
  const uploadId = await createBuildUploadAsync(request, appId, token, runtime);
  if (uploadId === null) return null;
  const reservation = await reserveUploadAsync(uploadId, archive.byteLength, token, runtime);
  if (reservation === null) return null;
  const transferred = await Promise.all(
    reservation.operations.map((operation) =>
      runtime.upload({
        method: operation.method,
        url: operation.url,
        headers: operation.headers,
        body: archive.slice(operation.offset, operation.offset + operation.length),
      }),
    ),
  );
  if (!transferred.every(isSuccess)) return null;
  const committed = await safeRequestAsync(runtime, {
    method: 'PATCH',
    url: `${API}/buildUploadFiles/${encodeURIComponent(reservation.fileId)}`,
    token,
    body: JSON.stringify({
      data: { type: 'buildUploadFiles', id: reservation.fileId, attributes: { uploaded: true } },
    }),
  });
  if (committed === null || !isSuccess(committed.status)) return null;
  return waitForBuildAsync(uploadId, request.artifact.buildNumber, token, runtime);
}

/*** Creates the App Store build-upload container. */
async function createBuildUploadAsync(
  request: IosPublishRequest,
  appId: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<string | null> {
  const response = await safeRequestAsync(runtime, {
    method: 'POST',
    url: `${API}/buildUploads`,
    token,
    body: JSON.stringify({
      data: {
        type: 'buildUploads',
        attributes: {
          cfBundleShortVersionString: request.version,
          cfBundleVersion: request.artifact.buildNumber,
          platform: 'IOS',
        },
        relationships: { app: { data: { type: 'apps', id: appId } } },
      },
    }),
  });
  return response?.status === 201 ? readResourceId(response.body, 'buildUploads') : null;
}

/*** Reserves signed upload operations for the IPA bytes. */
async function reserveUploadAsync(
  uploadId: string,
  fileSize: number,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<{ readonly fileId: string; readonly operations: readonly UploadOperation[] } | null> {
  const response = await safeRequestAsync(runtime, {
    method: 'POST',
    url: `${API}/buildUploadFiles`,
    token,
    body: JSON.stringify({
      data: {
        type: 'buildUploadFiles',
        attributes: { assetType: 'ASSET', fileName: 'application.ipa', fileSize },
        relationships: { buildUpload: { data: { type: 'buildUploads', id: uploadId } } },
      },
    }),
  });
  if (response?.status !== 201) return null;
  const value = parseJson(response.body);
  if (!isRecord(value) || !isRecord(value.data) || !isNonEmptyString(value.data.id)) return null;
  if (!isRecord(value.data.attributes) || !Array.isArray(value.data.attributes.uploadOperations))
    return null;
  const operations = value.data.attributes.uploadOperations.map(parseUploadOperation);
  return operations.every((item): item is UploadOperation => item !== null)
    ? { fileId: value.data.id, operations }
    : null;
}

/*** Parses one signed App Store upload operation. */
function parseUploadOperation(value: unknown): UploadOperation | null {
  if (!isRecord(value)) return null;
  if (!Number.isSafeInteger(value.offset) || !Number.isSafeInteger(value.length)) return null;
  if (typeof value.offset !== 'number' || typeof value.length !== 'number' || value.length <= 0)
    return null;
  if (!isNonEmptyString(value.method) || !isNonEmptyString(value.url)) return null;
  const headers = Array.isArray(value.requestHeaders)
    ? value.requestHeaders.flatMap((header) =>
        isRecord(header) && isNonEmptyString(header.name) && typeof header.value === 'string'
          ? [{ name: header.name, value: header.value }]
          : [],
      )
    : [];
  return {
    offset: value.offset,
    length: value.length,
    method: value.method,
    url: value.url,
    headers,
  };
}

/*** Polls the build upload until Apple exposes the processed build resource. */
async function waitForBuildAsync(
  uploadId: string,
  expectedBuildNumber: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<string | null> {
  for (const attempt of Array.from({ length: runtime.maxAttempts }, (_, index) => index)) {
    if (attempt > 0) await runtime.wait();
    const response = await safeRequestAsync(runtime, {
      method: 'GET',
      url: `${API}/buildUploads/${encodeURIComponent(uploadId)}?include=build&fields[builds]=version,processingState`,
      token,
    });
    if (response === null || !isSuccess(response.status)) return null;
    const value = parseJson(response.body);
    if (!isRecord(value) || !Array.isArray(value.included)) continue;
    const build = value.included.find(
      (item) =>
        isRecord(item) &&
        item.type === 'builds' &&
        isNonEmptyString(item.id) &&
        isRecord(item.attributes) &&
        item.attributes.version === expectedBuildNumber,
    );
    if (isRecord(build) && isNonEmptyString(build.id)) return build.id;
  }
  return null;
}

/*** Ensures an editable App Store version exists for the published version string. */
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

/*** Finds an existing version id, using undefined to represent a missing version. */
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
  const value = parseJson(response.body);
  if (!isRecord(value) || !Array.isArray(value.data)) return null;
  const matches = value.data.filter(
    (item) =>
      isRecord(item) && isRecord(item.attributes) && item.attributes.versionString === version,
  );
  if (matches.length === 0) return undefined;
  return matches.length === 1 && isRecord(matches[0]) && isNonEmptyString(matches[0].id)
    ? matches[0].id
    : null;
}

/*** Attaches a processed build to an App Store version. */
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

/*** Executes an App Store Connect request while containing transport failures. */
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

/*** Reads a JSON:API resource id from a response body. */
function readResourceId(body: string, type: string): string | null {
  const value = parseJson(body);
  return isRecord(value) &&
    isRecord(value.data) &&
    value.data.type === type &&
    isNonEmptyString(value.data.id)
    ? value.data.id
    : null;
}

/*** Reads one relationship resource id from a JSON:API object. */
function readRelationshipId(value: unknown, name: string, type: string): string | null {
  if (!isRecord(value) || !isRecord(value[name]) || !isRecord(value[name].data)) return null;
  const { data } = value[name];
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

/*** Creates the manual action required when the app is absent. */
function appRequired(): DeploymentProviderResult<IosPublishInspection> {
  return {
    status: 'action-required',
    action: {
      type: 'manual-action',
      target: 'ios',
      provider: 'app-store-connect',
      code: 'APP_STORE_APP_REQUIRED',
      message: 'Create the matching app in App Store Connect before iOS deployment.',
    },
  };
}

/*** Creates an iOS publication manual-action result. */
function publicationAction(code: string): DeploymentProviderResult<IosDeploymentPublication> {
  return {
    status: 'action-required',
    action: {
      type: 'manual-action',
      target: 'ios',
      provider: 'app-store-connect',
      code,
      message: 'App Store Connect requires provider action before iOS publication.',
    },
  };
}

/*** Creates a failed App Store inspection result. */
function failedInspection(code: string): DeploymentProviderResult<IosPublishInspection> {
  return {
    status: 'failed',
    failure: {
      code,
      message: 'App Store Connect iOS state could not be inspected.',
      target: 'ios',
      provider: 'app-store-connect',
    },
  };
}

/*** Creates a failed App Store publication result. */
function failedPublication(code: string): DeploymentProviderResult<IosDeploymentPublication> {
  return {
    status: 'failed',
    failure: {
      code,
      message: 'App Store Connect iOS publication failed.',
      target: 'ios',
      provider: 'app-store-connect',
    },
  };
}
