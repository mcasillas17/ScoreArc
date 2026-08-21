export type ApiErrorCode = 'INVALID_REQUEST' | 'NOT_FOUND' | 'UPSTREAM_UNAVAILABLE';

export function apiError(code: ApiErrorCode, status: number): Response {
  return Response.json({ error: { code } }, { status });
}
