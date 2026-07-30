// The Python worker owns all bulk Codeforces API traffic (handoff §2);
// the Next app only pokes it over HTTP.
//
// Every call carries the shared token: the worker can trigger a full re-sync
// or a Kattis crawl for any user, so reaching its URL must not be the same
// thing as being allowed to use it.
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
    const token = process.env.WORKER_TOKEN?.trim();
    res = await fetch(`${WORKER_URL}${path}`, {
      method: "POST",
      headers: token ? { "X-Worker-Token": token } : undefined,
    });
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
