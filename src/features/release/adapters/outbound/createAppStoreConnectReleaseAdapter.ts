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
import { isNonEmptyString } from '@ankhorage/utility/string';

import type { AppStoreConnectRuntime } from '../../../../utils/createAppStoreConnectRuntime.js';

const API = 'https://api.appstoreconnect.apple.com/v1';

interface ReleaseContext {
  readonly appId: string;
  readonly versionId: string;
  readonly version: Readonly<Record<string, unknown>>;
}

/*** Creates App Store release inspection, mutation, and lifecycle-control capabilities. */
export function createAppStoreConnectReleaseAdapter(
  runtime: AppStoreConnectRuntime,
): DeploymentReleaseAdapter {
  return {
    target: 'ios',
    inspectAsync: (request) => inspectAsync(request, runtime),
    executeStepAsync: (request) => executeStepAsync(request, runtime),
    controlAsync: (request) => controlAsync(request, runtime),
  };
}

/*** Inspects App Store version, release notes, review state, and phased rollout state. */
async function inspectAsync(
  request: ReleaseInspectionRequest,
  runtime: AppStoreConnectRuntime,
): Promise<DeploymentProviderResult<ReleaseObservedIosState>> {
  if (request.identity.target !== 'ios') return failedInspection('APP_STORE_RELEASE_IDENTITY_INVALID');
  const access = await runtime.resolveTokenAsync(request.credentials, request.resolveSecret);
  if (!access.ok) return { status: 'action-required', action: access.action };
  const context = await resolveReleaseContextAsync(
    request.identity.bundleIdentifier,
    request.version,
    access.token,
    runtime,
  );
  if (context === null) return { status: 'completed', value: missing() };
  const [notes, review, phased] = await Promise.all([
    readNotesAsync(context.versionId, access.token, runtime),
    readReviewStateAsync(context.appId, context.versionId, access.token, runtime),
    readPhasedReleaseAsync(context.versionId, access.token, runtime),
  ]);
  const attributes = isRecord(context.version.attributes) ? context.version.attributes : {};
  return {
    status: 'completed',
    value: {
      target: 'ios',
      version: request.version,
      artifactRevision: null,
      buildNumber: await readBuildNumberAsync(context.versionId, access.token, runtime),
      releaseNotes: notes,
      ...(typeof attributes.appVersionState === 'string'
        ? { appVersionState: attributes.appVersionState }
        : {}),
      ...(typeof attributes.releaseType === 'string' ? { releaseType: attributes.releaseType } : {}),
      ...(review.state === undefined ? {} : { reviewState: review.state }),
      phasedReleaseState: phased.state,
    },
  };
}

/*** Executes one provider-owned App Store release plan step. */
async function executeStepAsync(
  request: ReleaseStepExecutionRequest,
  runtime: AppStoreConnectRuntime,
): Promise<ReleaseMutationResult> {
  if (request.identity.target !== 'ios' || request.step.target !== 'ios')
    return blocked('APP_STORE_RELEASE_TARGET_INVALID');
  if (request.step.operation === 'verify' || request.step.operation === 'record')
    return { status: 'completed' };
  if (!['sync-notes', 'submit-review', 'release', 'rollout'].includes(request.step.operation))
    return blocked('APP_STORE_RELEASE_STEP_UNSUPPORTED');
  const access = await runtime.resolveTokenAsync(request.credentials, request.resolveSecret);
  if (!access.ok) return blocked(access.action.code);
  const context = await resolveReleaseContextAsync(
    request.identity.bundleIdentifier,
    request.desired.version,
    access.token,
    runtime,
  );
  if (context === null) return blocked('APP_STORE_RELEASE_VERSION_REQUIRED');
  const success =
    request.step.operation === 'sync-notes'
      ? await syncNotesAsync(context.versionId, request, access.token, runtime)
      : request.step.operation === 'submit-review'
        ? await submitReviewAsync(context, access.token, runtime)
        : request.step.operation === 'rollout' && request.desired.rollout.ios?.mode === 'staged'
          ? await ensurePhasedReleaseAsync(context.versionId, access.token, runtime)
          : await requestReleaseAsync(context.versionId, access.token, runtime);
  return success ? { status: 'completed' } : failedMutation('APP_STORE_RELEASE_MUTATION_FAILED');
}

/*** Executes App Store phased-rollout and review cancellation controls. */
async function controlAsync(
  request: ReleaseControlRequest,
  runtime: AppStoreConnectRuntime,
): Promise<ReleaseControlExecutionResult> {
  if (request.identity.target !== 'ios' || request.control.target !== 'ios')
    return controlBlocked('APP_STORE_RELEASE_CONTROL_INVALID');
  const access = await runtime.resolveTokenAsync(request.credentials, request.resolveSecret);
  if (!access.ok) return controlBlocked(access.action.code);
  const context = await resolveReleaseContextAsync(
    request.identity.bundleIdentifier,
    request.desired.version,
    access.token,
    runtime,
  );
  if (context === null) return controlBlocked('APP_STORE_RELEASE_VERSION_REQUIRED');
  const result =
    request.control.action === 'cancel-review'
      ? await cancelReviewAsync(context.appId, context.versionId, access.token, runtime)
      : await mutatePhasedReleaseAsync(context.versionId, request.control.action, access.token, runtime);
  return result
    ? { status: 'completed', mutationAttempted: true }
    : { status: 'failed', mutationAttempted: true, code: 'APP_STORE_RELEASE_CONTROL_FAILED' };
}

/*** Resolves the matching app and App Store version resource. */
async function resolveReleaseContextAsync(
  bundleIdentifier: string,
  version: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<ReleaseContext | null> {
  const apps = await readCollectionAsync(
    `${API}/apps?filter[bundleId]=${encodeURIComponent(bundleIdentifier)}&limit=2`,
    token,
    runtime,
  );
  const app = apps.find(
    (value) => isRecord(value) && isRecord(value.attributes) && value.attributes.bundleId === bundleIdentifier,
  );
  if (!isRecord(app) || !isNonEmptyString(app.id)) return null;
  const versions = await readCollectionAsync(
    `${API}/apps/${encodeURIComponent(app.id)}/appStoreVersions?filter[platform]=IOS&limit=200`,
    token,
    runtime,
  );
  const item = versions.find(
    (value) => isRecord(value) && isRecord(value.attributes) && value.attributes.versionString === version,
  );
  return isRecord(item) && isNonEmptyString(item.id)
    ? { appId: app.id, versionId: item.id, version: item }
    : null;
}

/*** Reads localized what's-new notes for a release. */
async function readNotesAsync(
  versionId: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<ReleaseObservedIosState['releaseNotes']> {
  const values = await readCollectionAsync(
    `${API}/appStoreVersions/${encodeURIComponent(versionId)}/appStoreVersionLocalizations?limit=200`,
    token,
    runtime,
  );
  return values.flatMap((value) =>
    isRecord(value) &&
    isRecord(value.attributes) &&
    isNonEmptyString(value.attributes.locale) &&
    typeof value.attributes.whatsNew === 'string'
      ? [{ locale: value.attributes.locale, text: value.attributes.whatsNew }]
      : [],
  );
}

/*** Reads the build number attached to an App Store version. */
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
  const value = parseResource(response.body);
  return value !== null && isRecord(value.attributes) && isNonEmptyString(value.attributes.version)
    ? value.attributes.version
    : null;
}

/*** Reads the review submission associated with the version. */
async function readReviewStateAsync(
  appId: string,
  versionId: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<{ readonly id?: string; readonly state?: string }> {
  const values = await readCollectionAsync(
    `${API}/apps/${encodeURIComponent(appId)}/reviewSubmissions?include=appStoreVersionForReview&limit=200`,
    token,
    runtime,
  );
  const match = values.find((value) => relationshipMatches(value, 'appStoreVersionForReview', versionId));
  if (!isRecord(match)) return {};
  return {
    ...(isNonEmptyString(match.id) ? { id: match.id } : {}),
    ...(isRecord(match.attributes) && typeof match.attributes.state === 'string'
      ? { state: match.attributes.state }
      : {}),
  };
}

/*** Reads the phased-release resource and portable state. */
async function readPhasedReleaseAsync(
  versionId: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<{
  readonly id?: string;
  readonly state: ReleaseObservedIosState['phasedReleaseState'];
}> {
  const response = await safeRequestAsync(runtime, {
    method: 'GET',
    url: `${API}/appStoreVersions/${encodeURIComponent(versionId)}/appStoreVersionPhasedRelease`,
    token,
  });
  if (response === null || response.status === 404) return { state: null };
  const value = parseResource(response.body);
  if (value === null) return { state: null };
  const state = isRecord(value.attributes) ? value.attributes.phasedReleaseState : undefined;
  return {
    ...(isNonEmptyString(value.id) ? { id: value.id } : {}),
    state:
      state === 'INACTIVE' || state === 'ACTIVE' || state === 'PAUSED' || state === 'COMPLETE'
        ? state
        : null,
  };
}

/*** Synchronizes localized release notes, creating missing localization resources when needed. */
async function syncNotesAsync(
  versionId: string,
  request: ReleaseStepExecutionRequest,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<boolean> {
  const existing = await readCollectionAsync(
    `${API}/appStoreVersions/${encodeURIComponent(versionId)}/appStoreVersionLocalizations?limit=200`,
    token,
    runtime,
  );
  const results = await Promise.all(
    request.desired.notes.map(async (note) => {
      const current = existing.find(
        (value) => isRecord(value) && isRecord(value.attributes) && value.attributes.locale === note.locale,
      );
      const id = isRecord(current) && isNonEmptyString(current.id) ? current.id : undefined;
      const response = await safeRequestAsync(runtime, {
        method: id === undefined ? 'POST' : 'PATCH',
        url:
          id === undefined
            ? `${API}/appStoreVersionLocalizations`
            : `${API}/appStoreVersionLocalizations/${encodeURIComponent(id)}`,
        token,
        body: JSON.stringify({
          data: {
            type: 'appStoreVersionLocalizations',
            ...(id === undefined ? {} : { id }),
            attributes: { locale: note.locale, whatsNew: note.text },
            ...(id === undefined
              ? {
                  relationships: {
                    appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } },
                  },
                }
              : {}),
          },
        }),
      });
      return response !== null && isSuccess(response.status);
    }),
  );
  return results.every(Boolean);
}

/*** Creates and submits an App Store review submission for the version. */
async function submitReviewAsync(
  context: ReleaseContext,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<boolean> {
  const created = await safeRequestAsync(runtime, {
    method: 'POST',
    url: `${API}/reviewSubmissions`,
    token,
    body: JSON.stringify({
      data: {
        type: 'reviewSubmissions',
        attributes: { platform: 'IOS' },
        relationships: { app: { data: { type: 'apps', id: context.appId } } },
      },
    }),
  });
  const submissionId = created?.status === 201 ? readResourceId(created.body, 'reviewSubmissions') : null;
  if (submissionId === null) return false;
  const item = await safeRequestAsync(runtime, {
    method: 'POST',
    url: `${API}/reviewSubmissionItems`,
    token,
    body: JSON.stringify({
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: submissionId } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: context.versionId } },
        },
      },
    }),
  });
  if (item?.status !== 201) return false;
  const submitted = await safeRequestAsync(runtime, {
    method: 'PATCH',
    url: `${API}/reviewSubmissions/${encodeURIComponent(submissionId)}`,
    token,
    body: JSON.stringify({
      data: { type: 'reviewSubmissions', id: submissionId, attributes: { submitted: true } },
    }),
  });
  return submitted !== null && isSuccess(submitted.status);
}

/*** Requests manual release of an approved App Store version. */
async function requestReleaseAsync(
  versionId: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<boolean> {
  const response = await safeRequestAsync(runtime, {
    method: 'POST',
    url: `${API}/appStoreVersionReleaseRequests`,
    token,
    body: JSON.stringify({
      data: {
        type: 'appStoreVersionReleaseRequests',
        relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } },
      },
    }),
  });
  return response?.status === 201;
}

/*** Ensures a phased release exists for staged rollout. */
async function ensurePhasedReleaseAsync(
  versionId: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<boolean> {
  const existing = await readPhasedReleaseAsync(versionId, token, runtime);
  if (existing.id !== undefined) return true;
  const response = await safeRequestAsync(runtime, {
    method: 'POST',
    url: `${API}/appStoreVersionPhasedReleases`,
    token,
    body: JSON.stringify({
      data: {
        type: 'appStoreVersionPhasedReleases',
        attributes: { phasedReleaseState: 'ACTIVE' },
        relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } },
      },
    }),
  });
  return response?.status === 201;
}

/*** Applies pause, resume, or cancel control to the phased release. */
async function mutatePhasedReleaseAsync(
  versionId: string,
  action: 'pause-phased' | 'resume-phased' | 'cancel-phased',
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<boolean> {
  const phased = await readPhasedReleaseAsync(versionId, token, runtime);
  if (phased.id === undefined) return false;
  if (action === 'cancel-phased') {
    const response = await safeRequestAsync(runtime, {
      method: 'DELETE',
      url: `${API}/appStoreVersionPhasedReleases/${encodeURIComponent(phased.id)}`,
      token,
    });
    return response !== null && isSuccess(response.status);
  }
  const response = await safeRequestAsync(runtime, {
    method: 'PATCH',
    url: `${API}/appStoreVersionPhasedReleases/${encodeURIComponent(phased.id)}`,
    token,
    body: JSON.stringify({
      data: {
        type: 'appStoreVersionPhasedReleases',
        id: phased.id,
        attributes: { phasedReleaseState: action === 'pause-phased' ? 'PAUSED' : 'ACTIVE' },
      },
    }),
  });
  return response !== null && isSuccess(response.status);
}

/*** Cancels the current review submission for one version. */
async function cancelReviewAsync(
  appId: string,
  versionId: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<boolean> {
  const review = await readReviewStateAsync(appId, versionId, token, runtime);
  if (review.id === undefined) return false;
  const response = await safeRequestAsync(runtime, {
    method: 'PATCH',
    url: `${API}/reviewSubmissions/${encodeURIComponent(review.id)}`,
    token,
    body: JSON.stringify({
      data: { type: 'reviewSubmissions', id: review.id, attributes: { canceled: true } },
    }),
  });
  return response !== null && isSuccess(response.status);
}

/*** Reads one JSON:API collection. */
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
): ReturnType<AppStoreConnectRuntime['request']> | Promise<null> {
  try {
    return await runtime.request(request);
  } catch {
    return null;
  }
}

/*** Tests a JSON:API relationship against a resource id. */
function relationshipMatches(value: unknown, name: string, id: string): boolean {
  if (!isRecord(value) || !isRecord(value.relationships) || !isRecord(value.relationships[name]))
    return false;
  const relationship = value.relationships[name];
  return isRecord(relationship.data) && relationship.data.id === id;
}

/*** Reads one JSON:API resource from a response body. */
function parseResource(body: string): Record<string, unknown> | null {
  const value = parseJson(body);
  return isRecord(value) && isRecord(value.data) ? value.data : null;
}

/*** Reads a JSON:API resource id. */
function readResourceId(body: string, type: string): string | null {
  const value = parseResource(body);
  return value !== null && value.type === type && isNonEmptyString(value.id) ? value.id : null;
}

/*** Parses JSON without exposing parser exceptions. */
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

/*** Creates a blocked release mutation. */
function blocked(code: string): ReleaseMutationResult {
  return { status: 'blocked', code };
}

/*** Creates a failed release mutation. */
function failedMutation(code: string): ReleaseMutationResult {
  return { status: 'failed', code };
}

/*** Creates a blocked release control result before mutation. */
function controlBlocked(code: string): ReleaseControlExecutionResult {
  return { status: 'blocked', mutationAttempted: false, code };
}

/*** Creates a failed release inspection result. */
function failedInspection(code: string): DeploymentProviderResult<ReleaseObservedIosState> {
  return {
    status: 'failed',
    failure: {
      code,
      message: 'App Store Connect release state could not be inspected.',
      target: 'ios',
      provider: 'app-store-connect',
    },
  };
}
