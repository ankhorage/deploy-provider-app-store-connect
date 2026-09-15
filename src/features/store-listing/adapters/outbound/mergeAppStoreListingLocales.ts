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
  return {
    locale,
    name: readString(info?.name) ?? locale,
    ...readAppInfoProperties(info),
    ...readVersionProperties(ver),
  };
}

/*** Maps optional App Info localization properties. */
function readAppInfoProperties(
  attributes: Readonly<Record<string, unknown>> | undefined,
): Partial<StoreListingLocale> {
  const summary = readString(attributes?.subtitle);
  const privacyPolicyUrl = readString(attributes?.privacyPolicyUrl);
  return {
    ...(summary === undefined ? {} : { summary }),
    ...(privacyPolicyUrl === undefined ? {} : { privacyPolicyUrl }),
  };
}

/*** Maps optional App Store version localization properties. */
function readVersionProperties(
  attributes: Readonly<Record<string, unknown>> | undefined,
): Partial<StoreListingLocale> {
  const description = readString(attributes?.description);
  const keywords = readKeywords(attributes?.keywords);
  const promotionalText = readString(attributes?.promotionalText);
  const supportUrl = readString(attributes?.supportUrl);
  const marketingUrl = readString(attributes?.marketingUrl);
  return {
    ...(description === undefined ? {} : { description }),
    ...(keywords === undefined ? {} : { keywords }),
    ...(promotionalText === undefined ? {} : { promotionalText }),
    ...(supportUrl === undefined ? {} : { supportUrl }),
    ...(marketingUrl === undefined ? {} : { marketingUrl }),
  };
}

/*** Parses a comma-separated keyword field. */
function readKeywords(value: unknown): readonly string[] | undefined {
  const keywords = readString(value);
  return keywords === undefined
    ? undefined
    : keywords
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}

/*** Reads one optional string localization property. */
function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
