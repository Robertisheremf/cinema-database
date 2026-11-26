/**
 * Bot 1: 24/7 Daily Archive Watcher
 * Polls HashHackers newest pages (page 1..N) for newly uploaded media,
 * optimizes metadata, and feeds directly into Turso (structured_media_catalog + media_fts).
 * Stops paginating as soon as an entire page is already present in Turso.
 */

import {
  ensureSyncStateTable,
  fetchArchivePage,
  ingestOptimizedFiles,
  setSyncState,
} from './optimizer.mjs';

const TARGETS = [
  { collection: 'mix_media_files', query: 'mkv' },
  { collection: 'mix_media_files', query: 'mp4' },
  { collection: 'files', query: 'mkv' },
];

const MAX_PAGES_PER_TARGET = parseInt(process.env.DAILY_MAX_PAGES || '5', 10);

async function run() {
  console.log('=== BOT 1: 24/7 DAILY WATCHER START ===');
  await ensureSyncStateTable();

  let totalInserted = 0;
  let totalQuarantined = 0;

  for (const target of TARGETS) {
    console.log(`\n[Daily] Scanning ${target.collection} (q=${target.query})...`);
    for (let page = 1; page <= MAX_PAGES_PER_TARGET; page++) {
      const data = await fetchArchivePage(target.collection, target.query, page);
      const files = Array.isArray(data?.files) ? data.files : [];
      console.log(
        `[Daily] ${target.collection}/${target.query} page ${page}: fetched ${files.length} files (total_files=${data?.total_files ?? 'n/a'})`
      );

      if (files.length === 0) break;

      const stats = await ingestOptimizedFiles(files);
      totalInserted += stats.inserted;
      totalQuarantined += stats.quarantined;

      console.log(
        `[Daily] Page ${page} result -> inserted: ${stats.inserted}, existing: ${stats.skippedExisting}, quarantined: ${stats.quarantined}`
      );

      // Stop paginating this target if every valid file on this page was already in Turso
      if (stats.inserted === 0 && stats.skippedExisting > 0) {
        console.log(`[Daily] Reached already-synced watermark on page ${page}. Stopping ${target.collection}/${target.query}.`);
        break;
      }

      await new Promise((r) => setTimeout(r, 350));
    }
  }

  await setSyncState('daily_last_run_at', new Date().toISOString());
  console.log(`\n=== BOT 1 COMPLETE: +${totalInserted} new optimized rows, ${totalQuarantined} quarantined ===`);
}

run().catch((err) => {
  console.error('❌ [Daily Bot Error]:', err.message);
  process.exit(1);
});
