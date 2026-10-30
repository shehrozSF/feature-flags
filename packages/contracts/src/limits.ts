export const LIMITS = {
  flagsPerProject: 50,
  variantsPerFlag: 10,
  rulesPerFlag: 20,
  conditionsPerRule: 10,
  rulesJsonBytes: 32768,
  contextKeys: 50,
} as const;

export const FLAG_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
