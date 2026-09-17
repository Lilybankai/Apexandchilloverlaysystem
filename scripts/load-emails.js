/**
 * scripts/load-emails.js — import the email templates from Node.
 * -----------------------------------------------------------------------------
 * supabase/functions/_shared/emails.ts is written for Deno, but it is ordinary
 * TypeScript with no Deno-only imports, and Node has stripped types from .ts
 * files since v22.6. The one obstacle is module format: this package is
 * CommonJS, so Node loads a bare `.ts` as CJS and chokes on its `export`s.
 *
 * The fix is a copy with an `.mts` extension, which is unambiguously ESM. Doing
 * it that way round — rather than renaming the real file, or dropping a
 * `{"type":"module"}` package.json next to it — keeps the deployed tree exactly
 * as the Supabase bundler expects it. Nothing in supabase/functions changes
 * shape to suit a test.
 *
 * The point of all this: the copy that `npm run test:emails` checks and that
 * `npm run email:preview` renders is byte-for-byte the copy the dispatcher
 * sends. A second implementation for previewing would drift within a week.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const SRC = path.join(__dirname, '..', 'supabase', 'functions', '_shared', 'emails.ts');

/**
 * @returns {Promise<{render:Function, hasTemplate:Function, STEP_KEYS:string[],
 *                    ASSET_BASE:string, UNSUB_BASE:string, FROM_NAME:string, REPLY_TO:string}>}
 */
async function loadEmails() {
  const src = fs.readFileSync(SRC, 'utf8');
  // Hashed filename so an edit is never served from Node's module cache, and
  // so two runs at once cannot fight over the same temp file.
  const hash = crypto.createHash('sha1').update(src).digest('hex').slice(0, 12);
  const file = path.join(os.tmpdir(), `apex-emails-${hash}.mts`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, src);
  return import(pathToFileURL(file).href);
}

module.exports = { loadEmails, SRC };
