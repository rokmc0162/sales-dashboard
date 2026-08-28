/**
 * The API error contract.
 *
 * Every route under /api answers a failure with the same body — `{ error: string }`
 * — because that is what every caller already reads: the settlement components,
 * the dashboard toasts, and `AnswerWorkbookReview` all do
 * `json.error || \`HTTP ${res.status}\``. These helpers exist so that shape lives
 * in one place instead of being retyped at ~85 call sites, and so a future change
 * (an error code, a request id) is one edit rather than a sweep.
 *
 * Status codes are the caller's decision and are never inferred here — a route
 * that answered 400 before must keep answering 400, or client branching breaks.
 *
 * There is deliberately no `apiSuccess()`. It would only wrap
 * `NextResponse.json(data)` without adding anything, and an indirection that
 * carries no meaning is worse than the call it replaces.
 */
import { NextResponse } from 'next/server';

/** A failure with a message we wrote ourselves (validation, not-found, ...). */
export function apiError(message: string, status = 500) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * A failed Supabase / PostgREST result. Pass the `error` from
 * `const { data, error } = await supabase...` straight through.
 */
export function apiFailure(error: { message: string }, status = 500) {
  return NextResponse.json({ error: error.message }, { status });
}

/**
 * Something thrown into a catch block. `unknown` is not always an Error, so the
 * message is extracted defensively rather than assumed.
 */
export function apiUnexpected(cause: unknown, status = 500) {
  const message =
    cause instanceof Error
      ? cause.message
      : typeof cause === 'string'
        ? cause
        : 'Unknown error';
  return NextResponse.json({ error: message }, { status });
}
