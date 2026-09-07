/**
 * Bulk-index a directory into the knowledge base from the command line.
 *
 *   npm run kb:index                 # indexes data/kb-samples
 *   npm run kb:index -- ./my-docs    # indexes a directory of your own
 *   npm run kb:index -- --clear      # empty the index first
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { KnowledgeBase, isSupported } from '@vll/rag';
import { serverConfig } from '../env.js';

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile() && isSupported(entry.name)) out.push(full);
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const clear = args.includes('--clear');
  const dirArg = args.find((a) => !a.startsWith('--'));
  const dir = resolve(dirArg ?? join(serverConfig.dataDir, 'kb-samples'));

  const kb = new KnowledgeBase({ dataDir: serverConfig.kbDir });
  await kb.load();

  if (clear) {
    await kb.clear();
    console.log('index cleared');
  }

  try {
    await stat(dir);
  } catch {
    console.error(`Directory not found: ${dir}`);
    process.exit(1);
  }

  const files = await walk(dir);
  if (files.length === 0) {
    console.error(`No supported documents found in ${dir}`);
    process.exit(1);
  }

  console.log(`Indexing ${files.length} file(s) from ${dir}\n`);
  let totalMs = 0;
  for (const f of files) {
    const buf = await readFile(f);
    const doc = await kb.addDocument(f.split(/[\\/]/).pop()!, buf);
    totalMs += doc.indexingMs;
    if (doc.error) console.log(`  ✗ ${doc.filename}: ${doc.error}`);
    else
      console.log(
        `  ✓ ${doc.filename.padEnd(34)} ${String(doc.chunkCount).padStart(4)} chunks  ${doc.indexingMs
          .toFixed(1)
          .padStart(8)} ms`,
      );
  }

  const s = kb.stats();
  console.log(`\nIndex: ${s.documents} documents, ${s.chunks} chunks, ${s.vocabulary} terms (${s.mode})`);
  console.log(`Total indexing time: ${totalMs.toFixed(1)} ms — all of it paid HERE, never during a voice turn.\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error('kb:index failed:', e);
  process.exit(1);
});
