/**
 * Bot 2: Backfill Archive Bot (Auto-Stops Permanently When Archive Is Complete)
 * Resumes from saved page checkpoints in Turso archive_sync_state,
 * optimizes remaining older archive pages into structured_media_catalog + media_fts,
 * and marks backfill_completed = 'true' once all targets finish.
 */

import {
  ensureSyncStateTable,
  fetchArchivePage,
  getSyncState,
  ingestOptimizedFiles,
  setSyncState,
} from './optimizer.mjs';

const TARGETS = [
  { collection: 'mix_media_files', query: 'mkv' },
  { collection: 'mix_media_files', query: 'mp4' },
  { collection: 'mix_media_files', query: 'avi' },
  { collection: 'mix_media_files', query: 'webm' },
  { collection: 'mix_media_files', query: 'rar' },
  { collection: 'mix_media_files', query: 'zip' },
  { collection: 'mix_media_files', query: '7z' },
  { collection: 'mix_media_files', query: 'ts' },
  { collection: 'mix_media_files', query: 'm4v' },
  { collection: 'files', query: 'mkv' },
  { collection: 'files', query: 'mp4' },
  { collection: 'files', query: 'avi' },
  { collection: 'files', query: 'webm' },
  { collection: 'files', query: 'rar' },
  { collection: 'files', query: 'zip' },
  { collection: 'files', query: '7z' },
  { collection: 'files', query: 'ts' },
  { collection: 'files', query: 'm4v' },
];

const PAGES_PER_RUN = parseInt(process.env.BACKFILL_PAGES_PER_RUN || '25', 10);

async function run() {
  console.log('=== BOT 2: BACKFILL BOT START ===');
  await ensureSyncStateTable();

  const completed = await getSyncState('backfill_completed', 'false');
  if (completed === 'true') {
    console.log('✅ Backfill already marked complete (backfill_completed=true). Bot 2 exiting cleanly.');
    return;
  }

  let pagesDoneThisRun = 0;
  let totalInserted = 0;
  let allTargetsFinished = true;

  for (const target of TARGETS) {
    const doneKey = `backfill_done_${target.collection}_${target.query}`;
    const pageKey = `backfill_page_${target.collection}_${target.query}`;

    const isTargetDone = await getSyncState(doneKey, 'false');
    if (isTargetDone === 'true') {
      console.log(`[Backfill] Target ${target.collection}/${target.query} already complete.`);
      continue;
    }

    allTargetsFinished = false;
    let currentPage = parseInt((await getSyncState(pageKey, '1')) || '1', 10);

    while (pagesDoneThisRun < PAGES_PER_RUN) {
      const data = await fetchArchivePage(target.collection, target.query, currentPage);
      const files = Array.isArray(data?.files) ? data.files : [];
      const totalPages = data?.total_pages || Math.ceil((data?.total_files || 0) / 100) || null;

      console.log(
        `[Backfill] ${target.collection}/${target.query} page ${currentPage}${totalPages ? '/' + totalPages : ''}: ${files.length} files`
      );

      if (files.length === 0 || (totalPages && currentPage >= totalPages)) {
        if (files.length > 0) {
          const stats = await ingestOptimizedFiles(files);
          totalInserted += stats.inserted;
        }
        await setSyncState(doneKey, 'true');
        console.log(`✅ [Backfill] Finished target ${target.collection}/${target.query} at page ${currentPage}!`);
        break;
      }

      const stats = await ingestOptimizedFiles(files);
      totalInserted += stats.inserted;
      console.log(
        `[Backfill] Page ${currentPage} -> inserted: ${stats.inserted}, existing: ${stats.skippedExisting}, quarantined: ${stats.quarantined}`
      );

      currentPage++;
      pagesDoneThisRun++;
      await setSyncState(pageKey, String(currentPage));

      await new Promise((r) => setTimeout(r, 400));
    }

    if (pagesDoneThisRun >= PAGES_PER_RUN) break;
  }

  // Re-check if all targets are now marked done
  if (!allTargetsFinished) {
    const doneFlags = await Promise.all(
      TARGETS.map((t) => getSyncState(`backfill_done_${t.collection}_${t.query}`, 'false'))
    );
    if (doneFlags.every((f) => f === 'true')) {
      await setSyncState('backfill_completed', 'true');
      console.log('🎉 ALL BACKFILL TARGETS COMPLETE! Bot 2 will now stay stopped.');
    }
  } else {
    await setSyncState('backfill_completed', 'true');
    console.log('🎉 ALL BACKFILL TARGETS COMPLETE! Bot 2 will now stay stopped.');
  }

  console.log(`=== BOT 2 RUN COMPLETE: ${pagesDoneThisRun} pages, +${totalInserted} new optimized rows ===`);
}

run().catch((err) => {
  console.error('❌ [Backfill Bot Error]:', err.message);
  process.exit(1);
});

