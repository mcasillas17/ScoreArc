export interface MonthLoadState<T> {
  matches: T[];
  loading: boolean;
  error: string | null;
}

export function monthLoadStarted<T>(state: MonthLoadState<T>): MonthLoadState<T> {
  return { ...state, loading: true, error: null };
}

export function returnedToLoadedMonth<T>(state: MonthLoadState<T>): MonthLoadState<T> {
  return { ...state, loading: false, error: null };
}

export function monthLoadSucceeded<T>(
  state: MonthLoadState<T>,
  matches: T[],
): MonthLoadState<T> {
  return { ...state, matches, loading: false, error: null };
}

export function monthLoadFailed<T>(
  state: MonthLoadState<T>,
  error: string,
): MonthLoadState<T> {
  return { ...state, matches: [], loading: false, error };
}
