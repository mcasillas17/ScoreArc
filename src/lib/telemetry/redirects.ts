export const isFetchRedirect = (status: number) => [301, 302, 303, 307, 308].includes(status);

/** A native follow hides intermediate responses. These callers only dispatch GET or HEAD with public headers. */
export async function fetchObservedRedirects(
  address: string, fetchHop: (address: string) => Promise<Response>, allowed: ((target: URL) => boolean) | undefined,
  onRedirect: (response: Response, next?: string) => void,
): Promise<Response> {
  for (let hops = 0; ; hops++) {
    const response = await fetchHop(address);
    if (!isFetchRedirect(response.status)) return response;
    const location = response.headers.get('location');
    if (allowed && location === null) return response;
    void response.body?.cancel().catch(() => {});
    const target = location !== null && URL.canParse(location, address) ? new URL(location, address) : undefined;
    if (!target || !allowed || hops >= 20 || target.username || target.password ||
        !['https:', 'http:'].includes(target.protocol) || !allowed(target)) {
      onRedirect(response);
      throw new TypeError('fetch failed');
    }
    address = target.href;
    onRedirect(response, address);
  }
}
