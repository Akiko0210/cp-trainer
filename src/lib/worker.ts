// The Python worker owns all bulk Codeforces API traffic (handoff §2);
// the Next app only pokes it over HTTP.
const WORKER_URL = process.env.WORKER_URL ?? "http://localhost:8787";

export class WorkerOfflineError extends Error {
  constructor() {
    super("The sync worker isn't running.");
  }
}

export async function workerPost<T = Record<string, unknown>>(
  path: string,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${WORKER_URL}${path}`, { method: "POST" });
  } catch {
    throw new WorkerOfflineError();
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(
      (body as { detail?: string } | null)?.detail ?? `Worker error (${res.status})`,
    );
  }
  return (await res.json()) as T;
}
