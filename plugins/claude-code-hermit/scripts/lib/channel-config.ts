// Reading the channels{} block of config.json. Shared by the booter and doctor
// so neither has to import the other.

type Json = any;

/** Python-style truthiness: empty arrays/objects/strings are falsy. */
export function pyTruthy(v: Json): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') return Object.keys(v).length > 0;
  return Boolean(v);
}

export function isDict(v: Json): boolean {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** Yield [name, cfg] for channels whose config is a valid dict. */
export function* iterChannelConfigs(config: Json): Generator<[string, Json]> {
  const channels = 'channels' in config ? config.channels : {};
  if (!isDict(channels)) return;
  for (const [name, cfg] of Object.entries(channels)) {
    if (isDict(cfg)) yield [name, cfg];
  }
}

/** Return list of enabled channel names. */
export function getEnabledChannels(config: Json): string[] {
  const names: string[] = [];
  for (const [name, cfg] of iterChannelConfigs(config)) {
    if (pyTruthy('enabled' in cfg ? cfg.enabled : true)) names.push(name);
  }
  return names;
}
