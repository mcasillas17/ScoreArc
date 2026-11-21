/**
 * setInterval that does nothing in a background tab, and catches up at once
 * when the tab comes back.
 *
 * Every live surface polls our own API, which reads the provider. A tab left
 * open behind another one kept doing that all day for nobody.
 *
 * Returns the cleanup for a useEffect.
 */
export function pollWhileVisible(tick: () => void, ms: number): () => void {
  const run = () => {
    if (!document.hidden) tick();
  };
  const id = setInterval(run, ms);
  document.addEventListener('visibilitychange', run);
  return () => {
    clearInterval(id);
    document.removeEventListener('visibilitychange', run);
  };
}
