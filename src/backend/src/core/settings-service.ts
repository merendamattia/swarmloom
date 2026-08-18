import type { Config } from "./config-schema.ts";
import { decryptSetting, encryptSetting } from "./settings-crypto.ts";
import {
  applyRuntimeSettings,
  configEnvironment,
  parseRuntimeSettingsPatch,
  patchToEnvironment,
  runtimeSettingDefinitions,
  runtimeSettingValues,
  runtimeSettingsView,
  telegramBootstrapValues,
} from "./runtime-settings.ts";
import { settingsRepository } from "../repositories/settings.ts";

export function createSettingsService(config: Config) {
  async function reload() {
    const rows = await settingsRepository.list(config.APP_ENV);
    const overrides = Object.fromEntries(rows.map((row) => [
      row.key,
      row.secret ? decryptSetting(row.value, config.SETTINGS_ENCRYPTION_KEY) : row.value,
    ]));
    Object.assign(config, applyRuntimeSettings(config, overrides));
    return config;
  }

  async function initialize() {
    const rows = await settingsRepository.list(config.APP_ENV);
    const existing = new Set(rows.map((row) => row.key));
    const values = runtimeSettingValues(config);
    const bootstrap = telegramBootstrapValues(config, rows);
    const bootstrapKeys = new Set(Object.keys(bootstrap));
    await settingsRepository.upsertMany(config.APP_ENV, runtimeSettingDefinitions
      .filter(({ key, secret }) => (!existing.has(key) || bootstrapKeys.has(key))
        && (!secret || Boolean(bootstrap[key] ?? values[key])))
      .map(({ key, secret }) => ({
        key,
        value: secret
          ? encryptSetting((bootstrap[key] ?? values[key])!, config.SETTINGS_ENCRYPTION_KEY)
          : (bootstrap[key] ?? values[key])!,
        secret,
      })));
    return reload();
  }

  async function update(input: unknown) {
    const patch = parseRuntimeSettingsPatch(input);
    const environmentPatch = patchToEnvironment(patch);
    const candidate = applyRuntimeSettings(config, environmentPatch);
    const values: Record<string, string | undefined> = configEnvironment(candidate);
    await settingsRepository.upsertMany(config.APP_ENV, Object.entries(environmentPatch).map(([key]) => {
      const definition = runtimeSettingDefinitions.find((item) => item.key === key);
      if (!definition) throw new Error(`Unsupported runtime setting: ${key}`);
      const value = values[key];
      return {
        key,
        value: definition.secret ? encryptSetting(value!, config.SETTINGS_ENCRYPTION_KEY) : value!,
        secret: definition.secret,
      };
    }));
    Object.assign(config, candidate);
    return config;
  }

  return {
    initialize,
    reload,
    update,
    view: () => runtimeSettingsView(config),
  };
}

export type SettingsService = ReturnType<typeof createSettingsService>;
