import { redactSecrets } from "../core/secrets.ts";

type ProcessResult = { exitCode: number; stderr: string };

export class ProviderProcessError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly stderr: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ProviderProcessError";
  }
}

export function providerEnvironment(environment: Record<string, string | undefined>) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !key.endsWith("_API_KEY")));
}

export async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void | Promise<void>,
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) await onLine(line);
    if (done) break;
  }
  if (pending.trim()) await onLine(pending);
}

export async function runJsonlProcess(
  command: string[],
  input: string,
  signal: AbortSignal | undefined,
  onJson: (event: unknown) => void | Promise<void>,
  environment = providerEnvironment(globalThis.process.env),
): Promise<ProcessResult> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  const process = Bun.spawn(command, {
    cwd: undefined,
    env: environment,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const abort = () => process.kill();
  signal?.addEventListener("abort", abort, { once: true });
  process.stdin.write(input);
  process.stdin.end();

  let parseError: unknown;
  const stdout = readLines(process.stdout, async (line) => {
    try {
      await onJson(JSON.parse(line));
    } catch (error) {
      parseError ??= error;
    }
  });
  const stderr = new Response(process.stderr).text();
  const [exitCode, errorText] = await Promise.all([process.exited, stderr, stdout])
    .then(([code, error]) => [code, error] as const)
    .finally(() => signal?.removeEventListener("abort", abort));
  if (parseError) throw new ProviderProcessError("Provider emitted invalid JSONL", exitCode, redactSecrets(errorText.slice(-8_000), environment), parseError);
  return { exitCode, stderr: redactSecrets(errorText.slice(-8_000), environment) };
}
