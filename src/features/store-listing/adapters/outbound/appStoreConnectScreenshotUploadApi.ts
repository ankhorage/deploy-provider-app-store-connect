import type {
  StoreListingAssetSet,
  StoreListingSyncRequest,
} from '@ankhorage/contracts/deploy-provider';
import { isRecord } from '@ankhorage/utility/object';
import { isNonEmptyString } from '@ankhorage/utility/string';

import type { AppStoreConnectRuntime } from '../../../../utils/createAppStoreConnectRuntime.js';

const API = 'https://api.appstoreconnect.apple.com/v1';

interface ScreenshotReservation {
  readonly id: string;
  readonly operations: readonly {
    readonly offset: number;
    readonly length: number;
    readonly method: string;
    readonly url: string;
    readonly headers: readonly { readonly name: string; readonly value: string }[];
  }[];
}

export interface AppStoreConnectScreenshotUploadApi {
  uploadAssetsAsync(
    setId: string,
    request: StoreListingSyncRequest,
    desired: StoreListingAssetSet,
    token: string,
  ): Promise<boolean>;
}

/*** Creates App Store Connect screenshot upload operations. */
export function createAppStoreConnectScreenshotUploadApi(
  runtime: AppStoreConnectRuntime,
): AppStoreConnectScreenshotUploadApi {
  return {
    uploadAssetsAsync: (setId, request, desired, token) =>
      uploadAssetsAsync(setId, request, desired, token, runtime),
  };
}

/*** Uploads all desired screenshot assets into one provider screenshot set. */
async function uploadAssetsAsync(
  setId: string,
  request: StoreListingSyncRequest,
  desired: StoreListingAssetSet,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<boolean> {
  for (const asset of desired.assets) {
    const bytes = await request.assets.readAsync(asset.relativePath);
    if (!(await uploadScreenshotAsync(setId, asset.relativePath, bytes, token, runtime))) {
      return false;
    }
  }
  return true;
}

/*** Reserves, transfers, and commits one App Store screenshot. */
async function uploadScreenshotAsync(
  setId: string,
  fileName: string,
  bytes: Uint8Array,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<boolean> {
  const reservation = await reserveScreenshotAsync(
    setId,
    fileName,
    bytes.byteLength,
    token,
    runtime,
  );
  if (reservation === null) return false;
  const statuses = await Promise.all(
    reservation.operations.map((operation) =>
      runtime.upload({
        method: operation.method,
        url: operation.url,
        headers: operation.headers,
        body: bytes.slice(operation.offset, operation.offset + operation.length),
      }),
    ),
  );
  if (!statuses.every(isSuccess)) return false;
  const committed = await safeRequestAsync(runtime, {
    method: 'PATCH',
    url: `${API}/appScreenshots/${encodeURIComponent(reservation.id)}`,
    token,
    body: JSON.stringify({
      data: { type: 'appScreenshots', id: reservation.id, attributes: { uploaded: true } },
    }),
  });
  return committed !== null && isSuccess(committed.status);
}

/*** Reserves signed upload operations for one screenshot. */
async function reserveScreenshotAsync(
  setId: string,
  fileName: string,
  fileSize: number,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<ScreenshotReservation | null> {
  const response = await safeRequestAsync(runtime, {
    method: 'POST',
    url: `${API}/appScreenshots`,
    token,
    body: JSON.stringify({
      data: {
        type: 'appScreenshots',
        attributes: { fileName, fileSize },
        relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: setId } } },
      },
    }),
  });
  if (response?.status !== 201) return null;
  const root = parseJson(response.body);
  if (!isRecord(root) || !isRecord(root.data) || !isNonEmptyString(root.data.id)) return null;
  if (!isRecord(root.data.attributes)) return null;
  const operations = unknownArray(root.data.attributes.uploadOperations).map(parseUploadOperation);
  if (operations.some((operation) => operation === null)) return null;
  return {
    id: root.data.id,
    operations: operations.filter((operation) => operation !== null),
  };
}

/*** Parses one screenshot upload operation. */
function parseUploadOperation(value: unknown): ScreenshotReservation['operations'][number] | null {
  if (!isRecord(value)) return null;
  const { offset, length, method, url } = value;
  if (typeof offset !== 'number' || typeof length !== 'number') return null;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0) {
    return null;
  }
  if (!isNonEmptyString(method) || !isNonEmptyString(url)) return null;
  const headers = unknownArray(value.requestHeaders).flatMap((header) =>
    isRecord(header) && isNonEmptyString(header.name) && typeof header.value === 'string'
      ? [{ name: header.name, value: header.value }]
      : [],
  );
  return { offset, length, method, url, headers };
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
