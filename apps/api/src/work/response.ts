/**
 * Sangam's `apiResponse(success, status, message, data)` envelope, flattened:
 * the ported services keep their calls, and callers get the data itself
 * (or `{ message }` when there is none) - the same shape as the rest of this API.
 * HTTP status codes come from Nest (201 for POST unless @HttpCode says otherwise).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function apiResponse<T = any>(_success: boolean, _status: number, message: string, data?: T | null): T {
  return (data ?? { message }) as T;
}
