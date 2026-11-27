/**
 * Bot 1: 24/7 Rolling-Cursor Recent-Year Archive Watcher
 *
 * HashHackers sorts search results by Telegram file_unique_id (id DESC), NOT
 * chronologically, so newly uploaded files land on arbitrary pages across the
 * index. Stopping on page 1 when existing=100 misses new uploads.
 *
 * Instead, this bot dynamically targets the current UTC year (and previous
 * year) using persistent rolling cursors in Turso sync_state, sweeping every
 * page in a continuous cycle so nothing recent is ever missed — including
 * automatic rollover when the calendar year changes.
 */

import {
  ensureSyncStateTable,
  fetchArchivePage,
  getSyncState,
  ingestOptimizedFiles,
  setSyncState,
} from "./optimizer.mjs";

const nowYear = new Date().getUTCFullYear();
const prevYear = nowYear - 1;
const envMax = parseInt(process.env.DAILY_MAX_PAGES || "0", 10) || 0;

const TARGETS = [
  {
    collection: "mix_media_files",
    query: String(nowYear),
    pagesPerRun: Math.max(25, envMax),
    stateKey: `daily_cursor_mix_${nowYear}`,
  },
  {
    collection: "files",
    query: String(nowYear),
    pagesPerRun: Math.max(10, envMax),
    stateKey: `daily_cursor_files_${nowYear}`,
  },
  {
    collection: "mix_media_files",
    query: String(prevYear),
    pagesPerRun: Math.max(10, envMax),
    stateKey: `daily_cursor_mix_${prevYear}`,
  },
];

async function run() {
  console.log(`=== BOT 1: 24/7 ROLLING DAILY WATCHER START (years: ${nowYear}, ${prevYear}) ===`);
  await ensureSyncStateTable();

  let totalInserted = 0;
  let totalQuarantined = 0;

  for (const target of TARGETS) {
    let cursor = parseInt((await getSyncState(target.stateKey, "1")) || "1", 10);
    if (!Number.isFinite(cursor) || cursor < 1) cursor = 1;

    console.log(`\n[Daily] Sweeping ${target.collection} (q=${target.query}) from page ${cursor} (${target.pagesPerRun} pages)...`);

    let nextPage = cursor;
    for (let i = 0; i < target.pagesPerRun; i++) {
      const page = cursor + i;
      const data = await fetchArchivePage(target.collection, target.query, page);
      const files = Array.isArray(data?.files) ? data.files : [];
      const totalPages = Math.max(1, parseInt(data?.total_pages || "1", 10) || 1);

      console.log(
        `[Daily] ${target.collection}/${target.query} page ${page}/${totalPages}: fetched ${files.length} files (total_files=${data?.total_files ?? "n/a"})`
      );

      if (files.length === 0) {
        nextPage = 1;
        break;
      }

      const stats = await ingestOptimizedFiles(files);
      totalInserted += stats.inserted;
      totalQuarantined += stats.quarantined;

      console.log(
        `[Daily] Page ${page} result -> inserted: ${stats.inserted}, existing: ${stats.skippedExisting}, quarantined: ${stats.quarantined}`
      );

      if (page >= totalPages) {
        console.log(`[Daily] Completed full sweep of ${target.collection}/${target.query} (page ${page}/${totalPages}). Wrapping to page 1.`);
        nextPage = 1;
        break;
      }

      nextPage = page + 1;
      await new Promise((r) => setTimeout(r, 350));
    }

    await setSyncState(target.stateKey, String(nextPage));
    console.log(`[Daily] Saved ${target.stateKey}=${nextPage}`);
  }

  await setSyncState("daily_last_run_at", new Date().toISOString());
  console.log(`\n=== BOT 1 COMPLETE: +${totalInserted} new optimized rows, ${totalQuarantined} quarantined ===`);
}

run().catch((err) => {
  console.error("❌ [Daily Bot Error]:", err.message);
  process.exit(1);
});
