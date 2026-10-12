import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { migrateSettingsShape, saveSettings, secretSlots, secretsStored, type SecretSlot, type Settings } from '../config.ts';
import type { Ctx } from '../context.ts';
import { Dopbase } from './dopbase.ts';

/**
 * Yaho's own keys and tokens (model providers, Composio, Slack) live in Dopbase, in the project named after
 * SETTINGS_PROJECT, next to the resource projects. settings.yaml keeps only what is safe to copy. In memory,
 * ctx.settings still holds the values, so the code that uses them does not change.
 */
export const SETTINGS_PROJECT = 'settings';

/** Dopbase keys from before providers, and what they are called now. */
const RENAMED: Record<string, string> = { LITELLM_API_KEY: 'PROVIDER_LITELLM_API_KEY', LITELLM_MASTER_KEY: 'PROVIDER_LITELLM_MASTER_KEY' };

const get = (s: Settings, slot: SecretSlot) => slot.holder(s)?.[slot.field] as string | undefined;
function set(s: Settings, slot: SecretSlot, value: string | undefined) {
  if (value === undefined) {
    const h = slot.holder(s);
    if (h) delete h[slot.field];
    return;
  }
  const h = slot.holder(s, true);
  if (h) h[slot.field] = value;
}

/** The last values known to be in Dopbase, so a save writes only what changed. */
const known = new Map<string, string>();

/**
 * At start, once Dopbase runs: read the secrets into ctx.settings, then move any still in settings.yaml into Dopbase
 * (each read back before it leaves the file). Without Dopbase nothing moves and the file keeps them.
 */
export async function loadSecrets(ctx: Ctx): Promise<{ moved: string[]; error?: string }> {
  const dop = new Dopbase(ctx);
  if (!dop.configured) return { moved: [], error: 'Dopbase is not running; keys stay in settings.yaml for now' };
  try {
    const stored = await dop.projectValues(SETTINGS_PROJECT);
    for (const [old, now] of Object.entries(RENAMED))
      if (stored[old] && !stored[now]) {
        await dop.setProjectValue(SETTINGS_PROJECT, now, stored[old]);
        await dop.deleteProjectValue(SETTINGS_PROJECT, old);
        stored[now] = stored[old];
      }
    const inFile = migrateSettingsShape((YAML.parse(readFileSync(ctx.paths.settings, 'utf8')) ?? {}) as Record<string, unknown>) as unknown as Settings;
    inFile.providers ??= [];
    const moved: string[] = [];
    for (const slot of secretSlots(ctx.settings)) {
      const fileValue = get(inFile, slot);
      if (fileValue) {
        if (stored[slot.key] !== fileValue) {
          await dop.setProjectValue(SETTINGS_PROJECT, slot.key, fileValue);
          const back = await dop.projectValues(SETTINGS_PROJECT);
          if (back[slot.key] !== fileValue) throw new Error(`could not confirm ${slot.key} in Dopbase`);
          stored[slot.key] = fileValue;
        }
        moved.push(slot.path);
      }
      const value = stored[slot.key];
      if (value) {
        set(ctx.settings, slot, value);
        known.set(slot.key, value);
        secretsStored.add(slot.path);
      }
    }
    if (moved.length) console.log(`[yaho] moved ${moved.join(', ')} from settings.yaml into Dopbase`);
    // Also writes a file from before providers in the new shape.
    saveSettings(ctx.settings);
    return { moved };
  } catch (e) {
    console.error(`[yaho] secrets: ${(e as Error).message}`);
    return { moved: [], error: (e as Error).message };
  }
}

/** Write changed secrets to Dopbase, then settings.yaml without them. Falls back to the file if Dopbase is down. */
export async function storeSecrets(ctx: Ctx): Promise<void> {
  const dop = new Dopbase(ctx);
  if (dop.configured) {
    for (const slot of secretSlots(ctx.settings)) {
      const value = get(ctx.settings, slot);
      if ((value ?? '') === (known.get(slot.key) ?? '')) {
        if (value) secretsStored.add(slot.path);
        continue;
      }
      if (value) await dop.setProjectValue(SETTINGS_PROJECT, slot.key, value);
      else await dop.deleteProjectValue(SETTINGS_PROJECT, slot.key);
      if (value) known.set(slot.key, value);
      else known.delete(slot.key);
      secretsStored.add(slot.path);
    }
  }
  saveSettings(ctx.settings);
}

/**
 * What the UI and the chat see: settings without secret values, plus which secrets are set (by path, e.g.
 * "providers.litellm.api_key"). An update from the UI leaves a secret alone when its field is absent, and clears it
 * when the field is null.
 */
export function publicSettings(s: Settings): Settings & { secrets_set: Record<string, boolean> } {
  const out = structuredClone(s);
  const secrets_set: Record<string, boolean> = {};
  for (const slot of secretSlots(s)) {
    secrets_set[slot.path] = !!get(s, slot);
    set(out, slot, undefined);
  }
  // The external Dopbase token cannot live in Dopbase (it is how Yaho reaches it), but it never goes to the UI either.
  secrets_set['dopbase.token'] = !!s.dopbase.token;
  delete out.dopbase.token;
  return { ...out, secrets_set };
}

/** Merge an update from the UI: secret fields that are absent keep their value, null clears them. */
export function applySettingsUpdate(current: Settings, next: Settings & { secrets_set?: unknown }): Settings {
  const before = new Map(secretSlots(current).map((slot) => [slot.path, get(current, slot)]));
  const dopbaseToken = current.dopbase.token;
  // What the core manages itself never comes from the UI: an old Settings page would otherwise undo Sign Out
  // Everywhere (session_epoch), the setup being done, or the claimed Slack owner.
  const kept = {
    epoch: current.server.session_epoch,
    onboarded: current.onboarded_at,
    owner: current.slack?.owner,
    since: current.slack?.since,
  };
  const { secrets_set: _, ...rest } = next;
  Object.assign(current, rest);
  current.server = { ...current.server, session_epoch: kept.epoch };
  if (kept.epoch === undefined) delete current.server.session_epoch;
  if (kept.onboarded === undefined) delete current.onboarded_at;
  else current.onboarded_at = kept.onboarded;
  if (current.slack || kept.owner) {
    current.slack = { ...current.slack };
    if (kept.owner === undefined) delete current.slack.owner;
    else current.slack.owner = kept.owner;
    if (kept.since === undefined) delete current.slack.since;
    else current.slack.since = kept.since;
  }
  if (next.dopbase && !('token' in next.dopbase)) current.dopbase.token = dopbaseToken;
  else if (next.dopbase && (next.dopbase as { token?: string | null }).token === null) delete current.dopbase.token;
  for (const slot of secretSlots(current)) {
    const given = slot.holder(current)?.[slot.field] as string | null | undefined;
    set(current, slot, given === undefined ? before.get(slot.path) : given === null ? undefined : given || undefined);
  }
  return current;
}
