import type { Settings } from './types.ts';

/**
 * Sentinel returned in place of the stored HA long-lived token by every
 * settings-bearing response. The API is unauthenticated, so the real token
 * must never leave the server. The UI posts full form snapshots back, so
 * POST /settings treats an incoming sentinel as "keep the stored token";
 * an explicit empty string still clears it.
 */
export const HA_TOKEN_SENTINEL = '__optivolt_redacted__';

/**
 * Copy of the settings that is safe to serialize to the client: the HA token
 * is replaced by the sentinel when one is stored, '' otherwise.
 */
export function redactSettingsForClient(settings: Settings): Settings {
  return { ...settings, haToken: settings.haToken ? HA_TOKEN_SENTINEL : '' };
}
