import type {
  ReleaseStepExecutionRequest,
} from '@ankhorage/contracts/deploy-provider';
import { isRecord } from '@ankhorage/utility/object';
import { isNonEmptyString } from '@ankhorage/utility/string';

import type { AppStoreReleaseContext } from '../../../../types/appStoreConnectRelease.js';
import type { AppStoreConnectRuntime } from '../../../../utils/createAppStoreConnectRuntime.js';
import type { AppStoreConnectReleaseInspectionApi } from './appStoreConnectReleaseInspectionApi.js';

const API = 'https://api.appstoreconnect.apple.com/v1';

type PhasedAction = 'pause-phased' | 'resume-phased' | 'cancel-phased';

export interface AppStoreConnectReleaseMutationApi {
  syncNotesAsync(
    versionId: string,
    request: ReleaseStepExecutionRequest,
    token: string,
  ): Promise<boolean>;
  submitReviewAsync(context: AppStoreReleaseContext, token: string): Promise<boolean>;
  requestReleaseAsync(versionId: string, token: string): Promise<boolean>;
  ensurePhasedReleaseAsync(versionId: string, token: string): Promise<boolean>;
  mutatePhasedReleaseAsync(
    versionId: string,
    action: PhasedAction,
    token: string,
  ): Promise<boolean>;
  cancelReviewAsync(appId: string, versionId: string, token: string): Promise<boolean>;
}

/*** Creates App Store Connect release mutation operations. */
export function createAppStoreConnectReleaseMutationApi(
  runtime: AppStoreConnectRuntime,
  inspection: AppStoreConnectReleaseInspectionApi,
): AppStoreConnectReleaseMutationApi {
  return {
    syncNotesAsync: (versionId, request, token) =>
      syncNotesAsync(versionId, request, token, runtime),
    submitReviewAsync: (context, token) => submitReviewAsync(context, token, runtime),
    requestReleaseAsync: (versionId, token) => requestReleaseAsync(versionId, token, runtime),
    ensurePhasedReleaseAsync: (versionId, token) =>
      ensurePhasedReleaseAsync(versionId, token, runtime, inspection),
    mutatePhasedReleaseAsync: (versionId, action, token) =>
      mutatePhasedReleaseAsync(versionId, action, token, runtime, inspection),
    cancelReviewAsync: (appId, versionId, token) =>
      cancelReviewAsync(appId, versionId, token, runtime, inspection),
  };
}

/*** Synchronizes localized release notes, creating missing resources when needed. */
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
  if (existing === null) return false;
  const results = await Promise.all(
    request.desired.notes.map((note) => writeReleaseNoteAsync(versionId, note, existing, token, runtime)),
  );
  return results.every(Boolean);
}

/*** Creates or patches one localized release note. */
async function writeReleaseNoteAsync(
  versionId: string,
  note: ReleaseStepExecutionRequest['desired']['notes'][number],
  existing: readonly unknown[],
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<boolean> {
  const current = existing.find(
    (value) =>
      isRecord(value) && isRecord(value.attributes) && value.attributes.locale === note.locale,
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
}

/*** Creates and submits an App Store review submission for one version. */
async function submitReviewAsync(
  context: AppStoreReleaseContext,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<boolean> {
  const submissionId = await createReviewSubmissionAsync(context.appId, token, runtime);
  if (submissionId === null) return false;
  if (!(await createReviewSubmissionItemAsync(submissionId, context.versionId, token, runtime))) {
    return false;
  }
  const response = await safeRequestAsync(runtime, {
    method: 'PATCH',
    url: `${API}/reviewSubmissions/${encodeURIComponent(submissionId)}`,
    token,
    body: JSON.stringify({
      data: { type: 'reviewSubmissions', id: submissionId, attributes: { submitted: true } },
    }),
  });
  return response !== null && isSuccess(response.status);
}

/*** Creates one review submission and returns its resource id. */
async function createReviewSubmissionAsync(
  appId: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<string | null> {
  const response = await safeRequestAsync(runtime, {
    method: 'POST',
    url: `${API}/reviewSubmissions`,
    token,
    body: JSON.stringify({
      data: {
        type: 'reviewSubmissions',
        attributes: { platform: 'IOS' },
        relationships: { app: { data: { type: 'apps', id: appId } } },
      },
    }),
  });
  return response?.status === 201 ? readResourceId(response.body, 'reviewSubmissions') : null;
}

/*** Attaches one App Store version to a review submission. */
async function createReviewSubmissionItemAsync(
  submissionId: string,
  versionId: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<boolean> {
  const response = await safeRequestAsync(runtime, {
    method: 'POST',
    url: `${API}/reviewSubmissionItems`,
    token,
    body: JSON.stringify({
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: submissionId } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } },
        },
      },
    }),
  });
  return response?.status === 201;
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
  inspection: AppStoreConnectReleaseInspectionApi,
): Promise<boolean> {
  const existing = await inspection.readPhasedAsync(versionId, token);
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

/*** Applies pause, resume, or cancel control to one phased release. */
async function mutatePhasedReleaseAsync(
  versionId: string,
  action: PhasedAction,
  token: string,
  runtime: AppStoreConnectRuntime,
  inspection: AppStoreConnectReleaseInspectionApi,
): Promise<boolean> {
  const phased = await inspection.readPhasedAsync(versionId, token);
  if (phased.id === undefined) return false;
  const response = await safeRequestAsync(runtime, {
    method: action === 'cancel-phased' ? 'DELETE' : 'PATCH',
    url: `${API}/appStoreVersionPhasedReleases/${encodeURIComponent(phased.id)}`,
    token,
    ...(action === 'cancel-phased'
      ? {}
      : {
          body: JSON.stringify({
            data: {
              type: 'appStoreVersionPhasedReleases',
              id: phased.id,
              attributes: {
                phasedReleaseState: action === 'pause-phased' ? 'PAUSED' : 'ACTIVE',
              },
            },
          }),
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
  inspection: AppStoreConnectReleaseInspectionApi,
): Promise<boolean> {
  const review = await inspection.readReviewAsync(appId, versionId, token);
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
): Promise<readonly unknown[] | null> {
  const response = await safeRequestAsync(runtime, { method: 'GET', url, token });
  if (response === null || !isSuccess(response.status)) return null;
  const root = parseJson(response.body);
  return isRecord(root) && Array.isArray(root.data)
    ? root.data.map((item: unknown) => item)
    : null;
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

/*** Reads one JSON:API resource id. */
function readResourceId(body: string, type: string): string | null {
  const root = parseJson(body);
  return isRecord(root) &&
    isRecord(root.data) &&
    root.data.type === type &&
    isNonEmptyString(root.data.id)
    ? root.data.id
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

/*** Tests whether an HTTP status is successful. */
function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}
