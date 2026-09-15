import type { StoreListingLocale } from '@ankhorage/contracts/deploy-provider';

import type { AppStoreListingResource } from '../../../../types/appStoreConnectListing.js';

/*** Merges App Info and version localization layers into portable listing locales. */
export function mergeAppStoreListingLocales(
  appInfo: readonly AppStoreListingResource[],
  version: readonly AppStoreListingResource[],
): readonly StoreListingLocale[] {
  const locales = [...new Set([...appInfo, ...version].map((item) => item.locale))].sort();
  return locales.map((locale) => mergeLocale(locale, appInfo, version));
}

/*** Merges one locale from App Info and version localization resources. */
function mergeLocale(
  locale: string,
  appInfo: readonly AppStoreListingResource[],
  version: readonly AppStoreListingResource[],
): StoreListingLocale {
  const info = appInfo.find((item) => item.locale === locale)?.attributes;
  const ver = version.find((item) => item.locale === locale)?.attributes;
  const summary = readString(info?.subtitle);
  const privacyPolicyUrl = readString(info?.privacyPolicyUrl);
  const description = readString(ver?.description);
  const keywords = readString(ver?.keywords);
  const promotionalText = readString(ver?.promotionalText);
  const supportUrl = readString(ver?.supportUrl);
  const marketingUrl = readString(ver?.marketingUrl);
  return {
    locale,
    name: readString(info?.name) ?? locale,
    ...(summary === undefined ? {} : { summary }),
    ...(privacyPolicyUrl === undefined ? {} : { privacyPolicyUrl }),
    ...(description === undefined ? {} : { description }),
    ...(keywords === undefined
      ? {}
      : {
          keywords: keywords
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
        }),
    ...(promotionalText === undefined ? {} : { promotionalText }),
    ...(supportUrl === undefined ? {} : { supportUrl }),
    ...(marketingUrl === undefined ? {} : { marketingUrl }),
  };
}

/*** Reads one optional string localization property. */
function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
