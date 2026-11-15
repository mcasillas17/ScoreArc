// Mirrors backend/shared/espn/collection.go. A full page needs a declared total
// before it can establish that there is no next page.
export function completeCollectionMetadata(envelope: Record<string, unknown>, count: number): boolean {
  for (;;) {
    for (const key of ['count', 'total', 'totalCount', 'pageCount', 'pageIndex', 'offset', 'pageSize', 'limit']) {
      if (!Object.hasOwn(envelope, key)) continue;
      const value = envelope[key];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return false;
      switch (key) {
        case 'count': case 'total': case 'totalCount':
          if (value !== count) return false;
          break;
        case 'pageCount':
          if (value !== 1 && !(value === 0 && count === 0)) return false;
          break;
        case 'pageIndex':
          if (value > 1) return false;
          break;
        case 'offset':
          if (value !== 0) return false;
          break;
        default:
          if (value < count || (value === count && count > 0 && !Object.hasOwn(envelope, 'total') && !Object.hasOwn(envelope, 'totalCount'))) return false;
      }
    }
    for (const key of ['truncated', 'hasMore']) if (Object.hasOwn(envelope, key) && envelope[key] !== false) return false;
    for (const key of ['next', 'nextPage']) if (Object.hasOwn(envelope, key) && envelope[key] !== null && envelope[key] !== '') return false;
    if (!Object.hasOwn(envelope, 'pagination')) return true;
    const pagination = envelope.pagination;
    if (!pagination || typeof pagination !== 'object' || Array.isArray(pagination)) return false;
    envelope = pagination as Record<string, unknown>;
  }
}
