export type CurrentDataStatus = {
  month: string;
  recordCount: number;
  warningCount: number;
  isComplete: boolean;
};

type CurrentStatusClientOptions = {
  fetchImpl?: typeof fetch;
  backoff?: (delayMs: number, signal: AbortSignal) => Promise<void>;
};

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [500, 1_500] as const;

function requestError(): Error {
  return new Error("current settlement status unavailable");
}

function abortError(): Error {
  const error = new Error("current settlement status request aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "name" in error
    && error.name === "AbortError";
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function defaultBackoff(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForRetry(
  attempt: number,
  signal: AbortSignal,
  backoff: NonNullable<CurrentStatusClientOptions["backoff"]>,
): Promise<void> {
  try {
    await backoff(RETRY_DELAYS_MS[attempt - 1], signal);
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw abortError();
    throw requestError();
  }
}

function parseCurrentStatus(payload: unknown, expectedMonth: string): CurrentDataStatus {
  if (typeof payload !== "object" || payload === null) throw requestError();

  const status = payload as Partial<CurrentDataStatus>;
  if (status.month !== expectedMonth
    || typeof status.recordCount !== "number"
    || typeof status.warningCount !== "number"
    || typeof status.isComplete !== "boolean") {
    throw requestError();
  }

  return {
    month: status.month,
    recordCount: status.recordCount,
    warningCount: status.warningCount,
    isComplete: status.isComplete,
  };
}

export async function fetchCurrentSettlementStatus(
  month: string,
  signal: AbortSignal,
  options: CurrentStatusClientOptions = {},
): Promise<CurrentDataStatus> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const backoff = options.backoff ?? defaultBackoff;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);

    let response: Response;
    try {
      response = await fetchImpl(`/api/settlement/current-status/${month}`, { signal });
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw abortError();
      if (attempt === MAX_ATTEMPTS) throw requestError();
      await waitForRetry(attempt, signal, backoff);
      continue;
    }

    throwIfAborted(signal);
    if (!response.ok) {
      if (response.status < 500 || response.status > 599 || attempt === MAX_ATTEMPTS) {
        throw requestError();
      }
      await waitForRetry(attempt, signal, backoff);
      continue;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw abortError();
      const transientReadFailure = error instanceof TypeError
        || (typeof error === "object" && error !== null && "name" in error && error.name === "TypeError");
      if (transientReadFailure && attempt < MAX_ATTEMPTS) {
        await waitForRetry(attempt, signal, backoff);
        continue;
      }
      throw requestError();
    }
    throwIfAborted(signal);
    return parseCurrentStatus(payload, month);
  }

  throw requestError();
}
