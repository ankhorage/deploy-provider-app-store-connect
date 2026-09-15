# Public API

## AppStoreConnectDeploymentProviderOptions

Kind: `type`
Module: `src/types/appStoreConnect.ts`
Source: `src/types/appStoreConnect.ts:43:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| createToken | property | `AppStoreConnectTokenFactory` | no |  |
| downloadArtifact | property | `AppStoreArtifactDownloader` | no |  |
| maxAttempts | property | `number` | no |  |
| now | property | `() => Date` | no |  |
| request | property | `AppStoreConnectTransport` | no |  |
| upload | property | `AppStoreUploadTransport` | no |  |
| wait | property | `() => Promise<void>` | no |  |

## createAppStoreConnectDeploymentProvider

Kind: `function`
Module: `src/features/provider-registration/composition/createAppStoreConnectDeploymentProvider.ts`
Source: `src/features/provider-registration/composition/createAppStoreConnectDeploymentProvider.ts:17:1`

Creates the canonical App Store Connect deployment provider registration.

monetization, release, and setup capabilities behind the portable deploy-provider contracts.

### Signatures

- `(options?: AppStoreConnectDeploymentProviderOptions) => DeploymentProviderRegistration`
  - options: `AppStoreConnectDeploymentProviderOptions` (optional)
  - returns: `DeploymentProviderRegistration`
