// Limits the app and the desktop page share.

/**
 * The most months one statement upload can cover. The real limit is the database's: on
 * Cloudflare's free plan one request gets about 50 queries, and an upload writes its
 * totals 20 (month, category) rows per query, for the shared part and the personal part.
 * Two years with every category used every month comes to about 35 queries.
 */
export const MAX_UPLOAD_MONTHS = 24;
