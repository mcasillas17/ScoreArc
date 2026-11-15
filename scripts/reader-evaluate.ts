/** Explicit local evaluation only; importing this module does not start work. */
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { pathToFileURL } from 'node:url';

type Arguments = { mode: 'disabled' } | { mode: 'offline' } | { mode: 'live'; manifest: string; readerOrigin: string };
export function parseEvaluationArgs(args: string[]): Arguments {
  if (args.length === 0) return { mode: 'disabled' };
  if (args.length === 1 && args[0] === '--offline') return { mode: 'offline' };
  if (args.length === 3 && args.filter(arg => arg === '--live').length === 1) {
    const manifest = args.filter(arg => arg.startsWith('--manifest='));
    const origins = args.filter(arg => arg.startsWith('--reader-origin='));
    if (manifest.length === 1 && origins.length === 1 && manifest[0].length > 11 && origins[0].length > 16) {
      return { mode: 'live', manifest: manifest[0].slice(11), readerOrigin: origins[0].slice(16) };
    }
  }
  throw new Error('Invalid evaluation arguments');
}

export async function readEvaluationManifest(path: string): Promise<unknown> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) throw new Error();
    const buffer = Buffer.alloc(32 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 32 * 1024) throw new Error();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))) as unknown;
  } catch { throw new Error('Invalid evaluation manifest'); }
  finally { await handle?.close(); }
}

export async function runEvaluationCLI(args: string[]): Promise<void> {
  const options = parseEvaluationArgs(args);
  const { evaluate } = await import('../src/server/data/evaluation/evaluate');
  if (options.mode === 'disabled') {
    console.log(JSON.stringify(await evaluate({ enabled: false })));
    return;
  }
  if (options.mode === 'offline') {
    const { createOfflineEvaluation } = await import('./reader-evaluation-fixtures');
    const fixture = await createOfflineEvaluation();
    try {
      const report = await evaluate({ enabled: true, offline: true, ...fixture });
      console.log(JSON.stringify(report));
    } finally { await fixture.close(); }
    return;
  }
  const manifest = await readEvaluationManifest(options.manifest);
  console.log(JSON.stringify(await evaluate({ enabled: true, manifest, readerOrigin: options.readerOrigin })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runEvaluationCLI(process.argv.slice(2)).catch(() => {
    console.error('Evaluation failed: check arguments, bounded manifest and reader origin.');
    process.exitCode = 1;
  });
}
