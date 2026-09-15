export interface AppStoreConnectApiKeyCredentials {
  readonly keyId: string;
  readonly issuerId: string;
  readonly privateKey: string;
}

export type AppStoreConnectTokenFactory = (
  credentials: AppStoreConnectApiKeyCredentials,
  now: Date,
) => Promise<string | null>;

export interface AppStoreConnectRequest {
  readonly method: 'DELETE' | 'GET' | 'PATCH' | 'POST';
  readonly url: string;
  readonly token: string;
  readonly body?: string;
}

export interface AppStoreConnectResponse {
  readonly status: number;
  readonly body: string;
}

export type AppStoreConnectTransport = (
  request: AppStoreConnectRequest,
) => Promise<AppStoreConnectResponse>;

export interface AppStoreUploadHeader {
  readonly name: string;
  readonly value: string;
}

export interface AppStoreUploadRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: readonly AppStoreUploadHeader[];
  readonly body: Uint8Array;
}

export type AppStoreUploadTransport = (request: AppStoreUploadRequest) => Promise<number>;
export type AppStoreArtifactDownloader = (url: string) => Promise<Uint8Array | null>;

export interface AppStoreConnectDeploymentProviderOptions {
  readonly createToken?: AppStoreConnectTokenFactory;
  readonly request?: AppStoreConnectTransport;
  readonly upload?: AppStoreUploadTransport;
  readonly downloadArtifact?: AppStoreArtifactDownloader;
  readonly wait?: () => Promise<void>;
  readonly now?: () => Date;
  readonly maxAttempts?: number;
}
