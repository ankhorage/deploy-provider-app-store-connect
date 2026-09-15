import type {
  DeploymentProviderResult,
  IosDeploymentPublication,
  IosDeploymentPublisher,
  IosPublishInspection,
  IosPublishInspectionRequest,
  IosPublishRequest,
} from '@ankhorage/contracts/deploy-provider';

import type { AppStoreConnectRuntime } from '../../../../utils/createAppStoreConnectRuntime.js';
import { createAppStoreConnectIosPublicationApi } from './appStoreConnectIosPublicationApi.js';

/*** Creates the iOS App Store Connect publisher, inspector, and verifier. */
export function createAppStoreConnectIosPublisher(
  runtime: AppStoreConnectRuntime,
): IosDeploymentPublisher {
  const api = createAppStoreConnectIosPublicationApi(runtime);
  return {
    inspectAsync: (request) => inspectAsync(request, runtime, api),
    publishAsync: (request) => publishAsync(request, runtime, api),
    verifyAsync: (request) => verifyAsync(request, runtime, api),
  };
}

type PublicationApi = ReturnType<typeof createAppStoreConnectIosPublicationApi>;

/*** Inspects the App Store version and attached build for one bundle identifier. */
async function inspectAsync(
  request: IosPublishInspectionRequest,
  runtime: AppStoreConnectRuntime,
  api: PublicationApi,
): Promise<DeploymentProviderResult<IosPublishInspection>> {
  const access = await runtime.resolveTokenAsync(request.credentials, request.resolveSecret);
  if (!access.ok) return { status: 'action-required', action: access.action };
  const appId = await api.findAppIdAsync(request.bundleIdentifier, access.token);
  if (appId === null) return appRequired();
  const version = await api.readVersionAsync(appId, request.version, access.token);
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
  api: PublicationApi,
): Promise<DeploymentProviderResult<IosDeploymentPublication>> {
  const access = await runtime.resolveTokenAsync(request.credentials, request.resolveSecret);
  if (!access.ok) return { status: 'action-required', action: access.action };
  const appId = await api.findAppIdAsync(request.bundleIdentifier, access.token);
  if (appId === null) return publicationAction('APP_STORE_APP_REQUIRED');
  const archive = await runtime.downloadArtifact(request.artifact.archiveUrl);
  if (archive === null) return failedPublication('IOS_ARCHIVE_DOWNLOAD_FAILED');
  const buildId = await api.uploadBuildAsync({
    appId,
    version: request.version,
    buildNumber: request.artifact.buildNumber,
    archive,
    token: access.token,
  });
  if (buildId === null) return failedPublication('APP_STORE_BUILD_UPLOAD_FAILED');
  const versionId = await api.ensureVersionAsync(appId, request.version, access.token);
  if (versionId === null) return failedPublication('APP_STORE_VERSION_PREPARATION_FAILED');
  if (!(await api.attachBuildAsync(versionId, buildId, access.token)))
    return failedPublication('APP_STORE_VERSION_BUILD_ATTACH_FAILED');
  return completedPublication(request);
}

/*** Verifies the expected version and build number through a fresh inspection. */
async function verifyAsync(
  request: IosPublishRequest,
  runtime: AppStoreConnectRuntime,
  api: PublicationApi,
): Promise<DeploymentProviderResult<IosPublishInspection>> {
  const inspection = await inspectAsync(request, runtime, api);
  if (inspection.status !== 'completed') return inspection;
  return inspection.value.version === request.version &&
    inspection.value.buildNumber === request.artifact.buildNumber
    ? inspection
    : failedInspection('APP_STORE_CONNECT_VERIFICATION_FAILED');
}

/*** Creates the completed portable iOS publication value. */
function completedPublication(
  request: IosPublishRequest,
): DeploymentProviderResult<IosDeploymentPublication> {
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

/*** Creates the manual action required when the matching App Store app is absent. */
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
