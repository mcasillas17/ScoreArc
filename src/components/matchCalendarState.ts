export interface MonthLoadState<T> {
  matches: T[];
  loading: boolean;
  error: string | null;
}

interface MonthLoadTransition<T> {
  state: MonthLoadState<T>;
  loadedRange: string | null;
}

export function monthNavigationAction(
  requestedRange: string,
  loadedRange: string | null,
): 'fetch' | 'restore' {
  return requestedRange === loadedRange ? 'restore' : 'fetch';
}

export function monthLoadStarted<T>(state: MonthLoadState<T>): MonthLoadState<T> {
  return { ...state, loading: true, error: null };
}

export function returnedToLoadedMonth<T>(state: MonthLoadState<T>): MonthLoadState<T> {
  return state.loading ? { ...state, loading: false, error: null } : state;
}

export function monthLoadSucceeded<T>(
  state: MonthLoadState<T>,
  matches: T[],
  loadedRange: string,
): MonthLoadTransition<T> {
  return {
    state: { ...state, matches, loading: false, error: null },
    loadedRange,
  };
}

export function monthLoadFailed<T>(
  state: MonthLoadState<T>,
  error: string,
): MonthLoadTransition<T> {
  return {
    state: { ...state, matches: [], loading: false, error },
    loadedRange: null,
  };
}
