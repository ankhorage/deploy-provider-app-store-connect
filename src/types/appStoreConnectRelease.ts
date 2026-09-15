import type { ReleaseObservedIosState } from '@ankhorage/contracts/deploy-provider';

export interface AppStoreReleaseContext {
  readonly appId: string;
  readonly versionId: string;
  readonly version: Readonly<Record<string, unknown>>;
}

export interface AppStoreReviewState {
  readonly id?: string;
  readonly state?: string;
}

export interface AppStorePhasedReleaseState {
  readonly id?: string;
  readonly state: ReleaseObservedIosState['phasedReleaseState'];
}
