/**
 * Shared Turso Cloud Client & Media Optimizer
 * - Filters spam/sample/non-media into junk_quarantine
 * - Extracts canonical_title, media_type, season, episode, is_batch, year, is_anime, quality, audio
 * - Upserts into structured_media_catalog AND keeps media_fts synced
 */

const TG_ARCHIVE = 'https://tga-hd.api.hashhackers.com';

const ANIME_KEYWORDS_RE =
  /\b(erai-raws|subsplease|horriblesubs|judas|crunchyroll|ani-dl|dual[\s._-]*audio.*anime|1080p[\s._-]*hevc[\s._-]*\[?batch\]?|one[\s._-]*piece|naruto|bleach|attack[\s._-]*on[\s._-]*titan|jujutsu[\s._-]*kaisen|demon[\s._-]*slayer|dragon[\s._-]*ball|solo[\s._-]*leveling|frieren|chainsaw[\s._-]*man|death[\s._-]*note)\b/i;

const JUNK_EXT_RE = /\.(txt|nfo|jpg|jpeg|png|webp|gif|url|lnk|exe|bat|cmd|apk|msi|srt|ass|vtt|sub|idx)$/i;
const VALID_MEDIA_RE = /\.(mkv|mp4|avi|webm|mov|m4v|ts|zip|rar|7z|\d{3})$/i;
const ADULT_NSFW_RE =
  /\b(xxx|porn|brazzers|bangbros|naughtyamerica|realitykings|blacked|tushy|vixen|deeper|slayed|mypervyfamily|freeusefantasy|auntjudys|auntjudysxxx|desperateamateurs|facefucktour|glowingdesire|onlyfans|xvideos|pornhub|xnxx|creampie|gangbang)\b/i;
const CAMERA_CLIP_RE = /^(?:VID|IMG|PXL|MOV|DSC|WA|Screen_?Recording|Screenshot)[_-]?\d{4,}/i;
const COURSE_JUNK_RE = /\b(module[\s._-]*\d+|lesson[\s._-]*\d+|lecture[\s._-]*\d+|udemy|coursera|faqs[\s._-]*module|hands-on[\s._-]*exercise)\b/i;

export function getEnvConfig() {
  const tgToken = process.env.TG_ARCHIVE_TOKEN;
  const tursoUrl = process.env.TURSO_CATALOG_URL;
  const tursoToken = process.env.TURSO_TOKEN;
  if (!tgToken || !tursoUrl || !tursoToken) {
    throw new Error('Missing required env vars: TG_ARCHIVE_TOKEN, TURSO_CATALOG_URL, TURSO_TOKEN');
  }
  return { tgToken, tursoUrl, tursoToken };
}

function toTursoArg(p) {
  if (p === null || p === undefined) return { type: 'null' };
  if (typeof p === 'number' && Number.isFinite(p)) {
    return Number.isInteger(p) ? { type: 'integer', value: String(p) } : { type: 'float', value: p };
  }
  return { type: 'text', value: String(p) };
}

export async function tursoExecuteBatch(statements) {
  const { tursoUrl, tursoToken } = getEnvConfig();
  const requests = statements.map((s) => ({
    type: 'execute',
    stmt: {
      sql: s.sql,
      args: (s.params || []).map(toTursoArg),
    },
  }));
  requests.push({ type: 'close' });

  const res = await fetch(tursoUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tursoToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ requests }),
    signal: AbortSignal.timeout(25000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Turso HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  return (data.results || []).map((r) => {
    if (r.type === 'error') {
      throw new Error(`Turso SQL error: ${r.error?.message || JSON.stringify(r.error)}`);
    }
    const exec = r.response?.result;
    if (!exec || !Array.isArray(exec.rows)) return [];
    const cols = exec.cols.map((c) => c.name);
    return exec.rows.map((row) => {
      const obj = {};
      cols.forEach((col, i) => {
        obj[col] = row[i] ? row[i].value : null;
      });
      return obj;
    });
  });
}

export async function ensureSyncStateTable() {
  await tursoExecuteBatch([
    {
      sql: `CREATE TABLE IF NOT EXISTS archive_sync_state (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT
      )`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS junk_quarantine (
        id TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        junk_reason TEXT NOT NULL,
        original_clean_title TEXT,
        created_at TEXT
      )`,
    },
  ]);
}

export async function getSyncState(key, defaultValue = null) {
  const [rows] = await tursoExecuteBatch([
    { sql: 'SELECT value FROM archive_sync_state WHERE key = ?', params: [key] },
  ]);
  return rows && rows.length > 0 ? rows[0].value : defaultValue;
}

export async function setSyncState(key, value) {
  await tursoExecuteBatch([
    {
      sql: 'INSERT OR REPLACE INTO archive_sync_state (key, value, updated_at) VALUES (?, ?, ?)',
      params: [key, String(value), new Date().toISOString()],
    },
  ]);
}

export async function fetchArchivePage(collection, query, page) {
  const { tgToken } = getEnvConfig();
  const targetUrl = `${TG_ARCHIVE}/${collection}/search?q=${encodeURIComponent(query)}&page=${page}`;
  const res = await fetch(targetUrl, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${tgToken}`,
      'x-auth-token': tgToken,
      Origin: 'https://bollywood.eu.org',
      Referer: 'https://bollywood.eu.org/',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HashHackers HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  return await res.json();
}

export function classifyAndOptimize(raw) {
  const id = String(raw.id || '').trim();
  const fileName = String(raw.file_name || raw.fileName || '').trim();
  const fileSize = parseInt(raw.file_size || raw.fileSize || 0, 10) || 0;
  if (!id || !fileName) return { isJunk: true, reason: 'missing_id_or_name' };

  const lower = fileName.toLowerCase();

  // Quarantine obvious junk/non-media/tiny samples
  if (JUNK_EXT_RE.test(lower)) {
    return { isJunk: true, id, fileName, fileSize, reason: 'non_media_ext' };
  }
  if (!VALID_MEDIA_RE.test(lower) && fileSize < 50 * 1024 * 1024) {
    return { isJunk: true, id, fileName, fileSize, reason: 'unrecognized_small_file' };
  }
  if (fileSize > 0 && fileSize < 5 * 1024 * 1024) {
    return { isJunk: true, id, fileName, fileSize, reason: 'tiny_under_5mb' };
  }
  if (/\bsample\b/i.test(lower) && fileSize < 120 * 1024 * 1024) {
    return { isJunk: true, id, fileName, fileSize, reason: 'sample_clip' };
  }
  if (ADULT_NSFW_RE.test(lower)) {
    return { isJunk: true, id, fileName, fileSize, reason: 'adult_nsfw' };
  }
  if (CAMERA_CLIP_RE.test(fileName)) {
    return { isJunk: true, id, fileName, fileSize, reason: 'personal_camera_clip' };
  }
  if (COURSE_JUNK_RE.test(lower)) {
    return { isJunk: true, id, fileName, fileSize, reason: 'course_tutorial' };
  }

  // Quality
  let quality = 'HD';
  if (/\b(2160p|4k|uhd)\b/i.test(fileName)) quality = '4K';
  else if (/\b(1080p|fhd)\b/i.test(fileName)) quality = '1080p';
  else if (/\b(720p|hd)\b/i.test(fileName)) quality = '720p';
  else if (/\b(480p|sd)\b/i.test(fileName)) quality = '480p';

  // Audio
  const audios = [];
  if (/\b(hindi|hin)\b/i.test(lower)) audios.push('Hindi');
  if (/\b(english|eng)\b/i.test(lower)) audios.push('English');
  if (/\b(tamil|tam)\b/i.test(lower)) audios.push('Tamil');
  if (/\b(telugu|tel)\b/i.test(lower)) audios.push('Telugu');
  if (/\b(dual[\s._-]*audio)\b/i.test(lower) && audios.length === 0) audios.push('Dual Audio');
  const audio = audios.join(', ') || 'Original';

  // Season / Episode / Batch
  const seMatch = fileName.match(/\bS(\d{1,2})[\s._-]*E(\d{1,3})\b/i);
  const sOnlyMatch = fileName.match(/\b(?:S|Season)[\s._-]*(\d{1,2})\b/i);
  const isBatch =
    /\b(complete|pack|batch|season[\s._-]*\d+[\s._-]*(?:complete|zip))\b/i.test(lower) ||
    /\.zip$/i.test(lower)
      ? 1
      : 0;
  const season = seMatch ? parseInt(seMatch[1], 10) : sOnlyMatch ? parseInt(sOnlyMatch[1], 10) : null;
  const episode = seMatch ? parseInt(seMatch[2], 10) : null;

  const isAnime = ANIME_KEYWORDS_RE.test(fileName) ? 1 : 0;
  const mediaType = isAnime ? 'anime' : season !== null || episode !== null || isBatch ? 'tv' : 'movie';

  // Year (exclude 2160p)
  let year = null;
  for (const m of fileName.matchAll(/\b(19\d{2}|20\d{2})\b/g)) {
    const idx = m.index ?? -1;
    if (idx !== -1 && fileName[idx + 4]?.toLowerCase() === 'p') continue;
    year = parseInt(m[1], 10);
    break;
  }

  // Canonical Title extraction
  let titlePart = fileName.replace(/\.(mkv|mp4|avi|webm|mov|m4v|ts|zip|rar|7z)(\.\d{3})?$/i, '');
  // Cut at year, season/episode tag, or quality tag whichever comes first
  const cutMatch = titlePart.match(
    /\b((?:19|20)\d{2}|S\d{1,2}\s*E?\d{0,3}|Season\s*\d{1,2}|2160p|1080p|720p|480p|4K|UHD|WEB-?DL|WEBRip|BluRay|BRRip|HDRip|HDTC|HDTS)\b/i
  );
  if (cutMatch && cutMatch.index > 1) {
    titlePart = titlePart.slice(0, cutMatch.index);
  }
  const canonicalTitle =
    titlePart
      .replace(/[._]+/g, ' ')
      .replace(/[\[\]()]+/g, ' ')
      .replace(/[-–—]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim() || fileName.slice(0, 60);

  return {
    isJunk: false,
    id,
    fileName,
    fileSize,
    canonicalTitle,
    mediaType,
    season,
    episode,
    isBatch,
    year,
    isAnime,
    quality,
    audio,
  };
}

export async function findExistingIds(ids) {
  if (!ids.length) return new Set();
  const existing = new Set();
  const chunkSize = 80;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(',');
    const [rows] = await tursoExecuteBatch([
      {
        sql: `SELECT id FROM structured_media_catalog WHERE id IN (${placeholders})`,
        params: chunk,
      },
    ]);
    for (const r of rows) {
      if (r.id) existing.add(String(r.id));
    }
  }
  return existing;
}

export async function ingestOptimizedFiles(rawFiles) {
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    return { inserted: 0, skippedExisting: 0, quarantined: 0 };
  }

  const parsed = rawFiles.map(classifyAndOptimize);
  const validItems = parsed.filter((p) => !p.isJunk);
  const junkItems = parsed.filter((p) => p.isJunk && p.id && p.fileName);

  const existingIds = await findExistingIds(validItems.map((v) => v.id));
  const toInsert = validItems.filter((v) => !existingIds.has(v.id));

  const now = new Date().toISOString();
  const stmts = [];

  for (const item of toInsert) {
    stmts.push({
      sql: `INSERT OR IGNORE INTO structured_media_catalog
            (id, file_name, file_size, canonical_title, media_type, season, episode, is_batch, year, is_anime, quality, audio, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        item.id,
        item.fileName,
        item.fileSize,
        item.canonicalTitle,
        item.mediaType,
        item.season,
        item.episode,
        item.isBatch,
        item.year,
        item.isAnime,
        item.quality,
        item.audio,
        now,
      ],
    });
    // Sync external-content FTS5 index for newly inserted row using O(1) rowid lookup
    stmts.push({
      sql: `INSERT INTO media_fts (rowid, canonical_title, file_name)
            SELECT rowid, canonical_title, file_name
            FROM structured_media_catalog
            WHERE id = ?
              AND NOT EXISTS (
                SELECT 1 FROM media_fts f WHERE f.rowid = structured_media_catalog.rowid
              )`,
      params: [item.id],
    });
  }

  for (const j of junkItems) {
    stmts.push({
      sql: `INSERT OR IGNORE INTO junk_quarantine
            (id, file_name, file_size, junk_reason, original_clean_title, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      params: [j.id, j.fileName, j.fileSize, j.reason, j.fileName, now],
    });
  }

  // Execute in chunks of 40 statements per HTTP pipeline call
  for (let i = 0; i < stmts.length; i += 40) {
    await tursoExecuteBatch(stmts.slice(i, i + 40));
  }

  return {
    inserted: toInsert.length,
    skippedExisting: existingIds.size,
    quarantined: junkItems.length,
  };
}

