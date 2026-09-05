import { pathToFileURL } from 'node:url';
import { affectsService } from './production-policy.mjs';
import { changedPaths } from './production-release.mjs';

/** @param {Record<string, string | undefined>} env @param {(base: string, sha: string) => string[]} diff */
export function previewBuildRequired(env, diff = changedPaths) {
  const base = env.VERCEL_GIT_PREVIOUS_SHA;
  const sha = env.VERCEL_GIT_COMMIT_SHA;
  if (env.VERCEL_ENV === 'production' || !base || !sha) return true;
  try {
    return diff(base, sha).some(path => affectsService(path, 'frontend'));
  } catch (error) {
    if (!(error instanceof Error) || !('status' in error) || ![1, 128].includes(error.status)) throw error;
    console.warn('Preview base unavailable or divergent; cannot prove unchanged, so a build is required.');
    return true;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const build = previewBuildRequired(process.env);
  console.log(build ? 'Build required (preview changes/bootstrap or CI production upload)' : 'Skipping unchanged preview');
  // Vercel's ignored-build convention: zero skips, nonzero proceeds to build.
  process.exitCode = build ? 1 : 0;
}
