import { isRecord } from '@ankhorage/utility/object';
import { isNonEmptyString } from '@ankhorage/utility/string';

import type { AppStoreConnectRuntime } from './createAppStoreConnectRuntime.js';

const API = 'https://api.appstoreconnect.apple.com/v1';

/*** Resolves the unique App Store Connect app id for one bundle identifier. */
export async function findAppStoreConnectAppIdAsync(
  bundleIdentifier: string,
  token: string,
  runtime: AppStoreConnectRuntime,
): Promise<string | null> {
  const query = new URLSearchParams({
    'filter[bundleId]': bundleIdentifier,
    'fields[apps]': 'bundleId',
    limit: '2',
  });
  try {
    const response = await runtime.request({
      method: 'GET',
      url: `${API}/apps?${query.toString()}`,
      token,
    });
    if (response.status < 200 || response.status >= 300) return null;
    const root: unknown = JSON.parse(response.body);
    if (!isRecord(root) || !Array.isArray(root.data)) return null;
    const values = root.data.map((item: unknown) => item);
    const matches = values.filter((item) => matchesBundleIdentifier(item, bundleIdentifier));
    const match = matches.length === 1 ? matches.at(0) : undefined;
    return isRecord(match) && isNonEmptyString(match.id) ? match.id : null;
  } catch {
    return null;
  }
}

/*** Checks whether one JSON:API app resource matches a bundle identifier. */
function matchesBundleIdentifier(value: unknown, bundleIdentifier: string): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isRecord(value.attributes) &&
    value.attributes.bundleId === bundleIdentifier
  );
}
