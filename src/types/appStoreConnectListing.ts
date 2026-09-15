export interface AppStoreListingResource {
  readonly id: string;
  readonly locale: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export interface AppStoreListingContext {
  readonly appInfoId: string;
  readonly versionId: string;
  readonly appInfo: readonly AppStoreListingResource[];
  readonly version: readonly AppStoreListingResource[];
}
