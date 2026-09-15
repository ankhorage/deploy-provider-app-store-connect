import { sign } from 'node:crypto';

import type {
  DeploymentAuthenticationRequiredAction,
  DeploymentCredentialReference,
  DeploymentSecretResolver,
} from '@ankhorage/contracts/deploy-provider';
import { isRecord } from '@ankhorage/utility/object';
import { isNonEmptyString } from '@ankhorage/utility/string';

import type {
  AppStoreArtifactDownloader,
  AppStoreConnectApiKeyCredentials,
  AppStoreConnectDeploymentProviderOptions,
  AppStoreConnectTokenFactory,
  AppStoreConnectTransport,
  AppStoreUploadTransport,
} from '../types/appStoreConnect.js';

export interface AppStoreConnectRuntime {
  readonly request: AppStoreConnectTransport;
  readonly upload: AppStoreUploadTransport;
  readonly downloadArtifact: AppStoreArtifactDownloader;
  readonly wait: () => Promise<void>;
  readonly now: () => Date;
  readonly maxAttempts: number;
  resolveTokenAsync(
    credentials: readonly DeploymentCredentialReference[],
    resolveSecret: DeploymentSecretResolver,
  ): Promise<
    | { readonly ok: true; readonly token: string }
    | { readonly ok: false; readonly action: DeploymentAuthenticationRequiredAction }
  >;
}

/*** Creates the concrete App Store Connect runtime boundary used by provider features. */
export function createAppStoreConnectRuntime(
  options: AppStoreConnectDeploymentProviderOptions = {},
): AppStoreConnectRuntime {
  const createToken = options.createToken ?? createAppStoreConnectTokenAsync;
  return {
    request: options.request ?? fetchAppStoreConnectAsync,
    upload: options.upload ?? uploadAppStoreAssetAsync,
    downloadArtifact: options.downloadArtifact ?? downloadAppStoreArtifactAsync,
    wait: options.wait ?? defaultWaitAsync,
    now: options.now ?? (() => new Date()),
    maxAttempts: options.maxAttempts ?? 20,
    resolveTokenAsync: (credentials, resolveSecret) =>
      resolveTokenAsync(credentials, resolveSecret, createToken, options.now ?? (() => new Date())),
  };
}

/*** Resolves API-key credentials and signs an App Store Connect token. */
async function resolveTokenAsync(
  credentials: readonly DeploymentCredentialReference[],
  resolveSecret: DeploymentSecretResolver,
  createToken: AppStoreConnectTokenFactory,
  now: () => Date,
): ReturnType<AppStoreConnectRuntime['resolveTokenAsync']> {
  const reference = credentials.find(
    (credential) => credential.provider === 'app-store-connect' && credential.kind === 'api-key',
  );
  if (reference === undefined) return authenticationRequired();
  try {
    const secret = await resolveSecret(reference);
    const parsed = parseApiKey(secret);
    if (parsed === null) return authenticationRequired();
    const token = await createToken(parsed, now());
    return token === null ? authenticationRequired() : { ok: true, token };
  } catch {
    return authenticationRequired();
  }
}

/*** Parses serialized App Store Connect API-key credentials. */
function parseApiKey(value: string | null): AppStoreConnectApiKeyCredentials | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return null;
    return isNonEmptyString(parsed.keyId) &&
      isNonEmptyString(parsed.issuerId) &&
      isNonEmptyString(parsed.privateKey)
      ? { keyId: parsed.keyId, issuerId: parsed.issuerId, privateKey: parsed.privateKey }
      : null;
  } catch {
    return null;
  }
}

/*** Creates the canonical authentication-required provider result fragment. */
function authenticationRequired(): {
  readonly ok: false;
  readonly action: DeploymentAuthenticationRequiredAction;
} {
  return {
    ok: false,
    action: {
      type: 'authentication',
      provider: 'app-store-connect',
      target: 'ios',
      code: 'APP_STORE_CONNECT_AUTHENTICATION_REQUIRED',
      message: 'App Store Connect API-key authentication is required for iOS deployment.',
    },
  };
}

/*** Signs a short-lived ES256 App Store Connect JWT. */
function createAppStoreConnectTokenAsync(
  credentials: AppStoreConnectApiKeyCredentials,
  now: Date,
): Promise<string | null> {
  try {
    const issuedAt = Math.floor(now.getTime() / 1000);
    const header = encodeJwtPart({ alg: 'ES256', kid: credentials.keyId, typ: 'JWT' });
    const payload = encodeJwtPart({
      iss: credentials.issuerId,
      iat: issuedAt,
      exp: issuedAt + 600,
      aud: 'appstoreconnect-v1',
    });
    const input = `${header}.${payload}`;
    const signature = sign('sha256', Buffer.from(input), {
      key: credentials.privateKey,
      dsaEncoding: 'ieee-p1363',
    });
    return Promise.resolve(`${input}.${signature.toString('base64url')}`);
  } catch {
    return Promise.resolve(null);
  }
}

/*** Encodes one JWT object as base64url JSON. */
function encodeJwtPart(value: Readonly<Record<string, string | number>>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/*** Executes an authenticated App Store Connect JSON API request. */
async function fetchAppStoreConnectAsync(
  request: Parameters<AppStoreConnectTransport>[0],
): ReturnType<AppStoreConnectTransport> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: {
      Authorization: `Bearer ${request.token}`,
      Accept: 'application/json',
      ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(request.body === undefined ? {} : { body: request.body }),
  });
  return { status: response.status, body: await response.text() };
}

/*** Uploads one signed binary App Store asset operation. */
async function uploadAppStoreAssetAsync(
  request: Parameters<AppStoreUploadTransport>[0],
): ReturnType<AppStoreUploadTransport> {
  const headers = new Headers();
  request.headers.forEach((header) => headers.append(header.name, header.value));
  const response = await fetch(request.url, { method: request.method, headers, body: request.body });
  return response.status;
}

/*** Downloads an iOS build artifact for App Store delivery. */
async function downloadAppStoreArtifactAsync(url: string): Promise<Uint8Array | null> {
  try {
    const response = await fetch(url);
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

/*** Waits between App Store Connect processing polls. */
function defaultWaitAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1500));
}
