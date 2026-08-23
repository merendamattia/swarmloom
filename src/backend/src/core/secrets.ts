export function redactSecrets(
  text: string,
  environment: Record<string, string | undefined> = globalThis.process.env,
) {
  const secrets = Object.entries(environment)
    .filter(([key, value]) => value && value.length >= 6
      && /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH|DATABASE_URL|GIT_CONFIG_VALUE)/i.test(key))
    .map(([, value]) => value as string)
    .sort((left, right) => right.length - left.length);
  return secrets.reduce((safe, secret) => safe.split(secret).join("[REDACTED]"), text);
}
