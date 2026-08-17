import type { Settings } from './types.ts';

/**
 * Returned in place of the stored HA token in settings-bearing responses.
 * POST /settings treats an incoming sentinel as "keep the stored token";
 * an explicit empty string still clears it.
 */
export const HA_TOKEN_SENTINEL = '__optivolt_redacted__';

/** Settings copy safe to serialize to the client. */
export function redactSettingsForClient(settings: Settings): Settings {
  return { ...settings, haToken: settings.haToken ? HA_TOKEN_SENTINEL : '' };
}
