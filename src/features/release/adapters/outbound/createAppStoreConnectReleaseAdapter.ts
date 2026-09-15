import type {
  DeploymentProviderResult,
  DeploymentReleaseAdapter,
  ReleaseControlExecutionResult,
  ReleaseControlRequest,
  ReleaseInspectionRequest,
  ReleaseMutationResult,
  ReleaseObservedIosState,
  ReleaseStepExecutionRequest,
} from '@ankhorage/contracts/deploy-provider';
import { isRecord } from '@ankhorage/utility/object';

import type { AppStoreConnectRuntime } from '../../../../utils/createAppStoreConnectRuntime.js';
import { createAppStoreConnectReleaseInspectionApi } from './appStoreConnectReleaseInspectionApi.js';
import { createAppStoreConnectReleaseMutationApi } from './appStoreConnectReleaseMutationApi.js';

/*** Creates App Store release inspection, mutation, and lifecycle-control capabilities. */
export function createAppStoreConnectReleaseAdapter(
  runtime: AppStoreConnectRuntime,
): DeploymentReleaseAdapter {
  const inspection = createAppStoreConnectReleaseInspectionApi(runtime);
  const mutation = createAppStoreConnectReleaseMutationApi(runtime, inspection);
  return {
    target: 'ios',
    inspectAsync: (request) => inspectAsync(request, runtime, inspection),
    executeStepAsync: (request) => executeStepAsync(request, runtime, inspection, mutation),
    controlAsync: (request) => controlAsync(request, runtime, inspection, mutation),
  };
}

type InspectionApi = ReturnType<typeof createAppStoreConnectReleaseInspectionApi>;
type MutationApi = ReturnType<typeof createAppStoreConnectReleaseMutationApi>;

/*** Inspects App Store version, release notes, review state, and phased rollout state. */
async function inspectAsync(
  request: ReleaseInspectionRequest,
  runtime: AppStoreConnectRuntime,
  inspection: InspectionApi,
): Promise<DeploymentProviderResult<ReleaseObservedIosState>> {
  if (request.identity.target !== 'ios') {
    return failedInspection('APP_STORE_RELEASE_IDENTITY_INVALID');
  }
  const access = await runtime.resolveTokenAsync(request.credentials, request.resolveSecret);
  if (!access.ok) return { status: 'action-required', action: access.action };
  const context = await inspection.resolveContextAsync(
    request.identity.bundleIdentifier,
    request.version,
    access.token,
  );
  if (context === null) return { status: 'completed', value: missing() };
  const [notes, review, phased, buildNumber] = await Promise.all([
    inspection.readNotesAsync(context.versionId, access.token),
    inspection.readReviewAsync(context.appId, context.versionId, access.token),
    inspection.readPhasedAsync(context.versionId, access.token),
    inspection.readBuildNumberAsync(context.versionId, access.token),
  ]);
  const attributes = isRecord(context.version.attributes) ? context.version.attributes : {};
  return {
    status: 'completed',
    value: {
      target: 'ios',
      version: request.version,
      artifactRevision: null,
      buildNumber,
      releaseNotes: notes,
      ...(typeof attributes.appVersionState === 'string'
        ? { appVersionState: attributes.appVersionState }
        : {}),
      ...(typeof attributes.releaseType === 'string'
        ? { releaseType: attributes.releaseType }
        : {}),
      ...(review.state === undefined ? {} : { reviewState: review.state }),
      phasedReleaseState: phased.state,
    },
  };
}

/*** Executes one provider-owned App Store release plan step. */
async function executeStepAsync(
  request: ReleaseStepExecutionRequest,
  runtime: AppStoreConnectRuntime,
  inspection: InspectionApi,
  mutation: MutationApi,
): Promise<ReleaseMutationResult> {
  if (request.identity.target !== 'ios' || request.step.target !== 'ios') {
    return blocked('APP_STORE_RELEASE_TARGET_INVALID');
  }
  if (request.step.operation === 'verify' || request.step.operation === 'record') {
    return { status: 'completed' };
  }
  if (!isSupportedOperation(request.step.operation)) {
    return blocked('APP_STORE_RELEASE_STEP_UNSUPPORTED');
  }
  const access = await runtime.resolveTokenAsync(request.credentials, request.resolveSecret);
  if (!access.ok) return blocked(access.action.code);
  const context = await inspection.resolveContextAsync(
    request.identity.bundleIdentifier,
    request.desired.version,
    access.token,
  );
  if (context === null) return blocked('APP_STORE_RELEASE_VERSION_REQUIRED');
  const success = await executeMutationAsync(request, context, access.token, mutation);
  return success ? { status: 'completed' } : failedMutation('APP_STORE_RELEASE_MUTATION_FAILED');
}

/*** Executes one supported release mutation. */
async function executeMutationAsync(
  request: ReleaseStepExecutionRequest,
  context: NonNullable<Awaited<ReturnType<InspectionApi['resolveContextAsync']>>>,
  token: string,
  mutation: MutationApi,
): Promise<boolean> {
  switch (request.step.operation) {
    case 'sync-notes':
      return mutation.syncNotesAsync(context.versionId, request, token);
    case 'submit-review':
      return mutation.submitReviewAsync(context, token);
    case 'rollout':
      return request.desired.rollout.ios?.mode === 'staged'
        ? mutation.ensurePhasedReleaseAsync(context.versionId, token)
        : mutation.requestReleaseAsync(context.versionId, token);
    case 'release':
      return mutation.requestReleaseAsync(context.versionId, token);
    default:
      return false;
  }
}

/*** Executes App Store phased-rollout and review cancellation controls. */
async function controlAsync(
  request: ReleaseControlRequest,
  runtime: AppStoreConnectRuntime,
  inspection: InspectionApi,
  mutation: MutationApi,
): Promise<ReleaseControlExecutionResult> {
  if (request.identity.target !== 'ios' || request.control.target !== 'ios') {
    return controlBlocked('APP_STORE_RELEASE_CONTROL_INVALID');
  }
  const access = await runtime.resolveTokenAsync(request.credentials, request.resolveSecret);
  if (!access.ok) return controlBlocked(access.action.code);
  const context = await inspection.resolveContextAsync(
    request.identity.bundleIdentifier,
    request.desired.version,
    access.token,
  );
  if (context === null) return controlBlocked('APP_STORE_RELEASE_VERSION_REQUIRED');
  const success =
    request.control.action === 'cancel-review'
      ? await mutation.cancelReviewAsync(context.appId, context.versionId, access.token)
      : await mutation.mutatePhasedReleaseAsync(
          context.versionId,
          request.control.action,
          access.token,
        );
  return success
    ? { status: 'completed', mutationAttempted: true }
    : { status: 'failed', mutationAttempted: true, code: 'APP_STORE_RELEASE_CONTROL_FAILED' };
}

/*** Checks whether a release operation is provider-owned by App Store Connect. */
function isSupportedOperation(operation: ReleaseStepExecutionRequest['step']['operation']): boolean {
  return (
    operation === 'sync-notes' ||
    operation === 'submit-review' ||
    operation === 'release' ||
    operation === 'rollout'
  );
}

/*** Creates the portable missing iOS release state. */
function missing(): ReleaseObservedIosState {
  return {
    target: 'ios',
    version: null,
    artifactRevision: null,
    buildNumber: null,
    releaseNotes: [],
    phasedReleaseState: null,
  };
}

/*** Creates a blocked release mutation result. */
function blocked(code: string): ReleaseMutationResult {
  return { status: 'blocked', code };
}

/*** Creates a failed release mutation result. */
function failedMutation(code: string): ReleaseMutationResult {
  return { status: 'failed', code };
}

/*** Creates a blocked release-control result. */
function controlBlocked(code: string): ReleaseControlExecutionResult {
  return { status: 'blocked', mutationAttempted: false, code };
}

/*** Creates a failed App Store release inspection result. */
function failedInspection(
  code: string,
): DeploymentProviderResult<ReleaseObservedIosState> {
  return {
    status: 'failed',
    failure: {
      code,
      message: 'App Store release state could not be inspected.',
      target: 'ios',
      provider: 'app-store-connect',
    },
  };
}
