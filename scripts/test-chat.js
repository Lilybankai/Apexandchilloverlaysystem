/**
 * scripts/test-chat.js — the pure parts of the live-chat hub.
 * -----------------------------------------------------------------------------
 * Two families of logic here are easy to get quietly wrong and impossible to
 * spot until one message renders mangled on a live stream:
 *
 *   1. Twitch IRCv3 parsing — the tag block, escaped values (a display name
 *      with a space arrives as `\s`), and above all the emote RANGES, which are
 *      CODE-POINT offsets: an emoji earlier in the line shifts every following
 *      emote by one if you index by UTF-16, painting the wrong words as images.
 *   2. YouTube normalization — only text events are lines; memberships and
 *      super-chats are events, and rendering them as text would misrepresent
 *      them. Author booleans map to the shared badge vocabulary.
 *
 * Runs against the compiled module (like the other test scripts), so build
 * first: npm run build && node scripts/test-chat.js  (the `test` script chains
 * both). No network — only the pure functions are exercised; the live IRC
 * socket and YouTube poller are integration-tested against a real stream.
 */

'use strict';

const chat = require('../dist/server/chatHub');

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  }
}

/* -------------------------------------------------------------------------- */
console.log('\nparseIrcLine — tags, prefix, command, trailing');
/* -------------------------------------------------------------------------- */

{
  const raw =
    '@badges=broadcaster/1;color=#FF0000;display-name=Speed\\sRacer;emotes=25:0-4;id=abc-123 ' +
    ':speed!speed@speed.tmi.twitch.tv PRIVMSG #apex :Kappa hello there';
  const line = chat.parseIrcLine(raw);
  check('command is PRIVMSG', line && line.command === 'PRIVMSG', line && line.command);
  check('trailing is the message', line && line.trailing === 'Kappa hello there', line && line.trailing);
  check('tag: color', line && line.tags.color === '#FF0000', line && line.tags.color);
  check('tag: id', line && line.tags.id === 'abc-123', line && line.tags.id);
  check('escaped space in display-name', line && line.tags['display-name'] === 'Speed Racer',
    line && line.tags['display-name']);
  check('channel param preserved', line && line.params[0] === '#apex', line && line.params[0]);
}
{
  const ping = chat.parseIrcLine('PING :tmi.twitch.tv');
  check('PING command parsed', ping && ping.command === 'PING' && ping.trailing === 'tmi.twitch.tv',
    ping && ping.command);
}
check('empty line → null', chat.parseIrcLine('') === null && chat.parseIrcLine('\r\n') === null);

/* -------------------------------------------------------------------------- */
console.log('\nparseTwitchEmotesTag — ordering + multiple ids');
/* -------------------------------------------------------------------------- */

{
  // Two emotes, one appearing twice, given out of order — must come back sorted.
  const ranges = chat.parseTwitchEmotesTag('1902:12-16/25:0-4,6-10');
  check('all occurrences captured', ranges.length === 3, ranges.length);
  check('sorted by start', ranges[0].start === 0 && ranges[1].start === 6 && ranges[2].start === 12,
    ranges.map((r) => r.start).join(','));
  check('ids kept with ranges', ranges[0].id === '25' && ranges[2].id === '1902',
    ranges[0].id + ',' + ranges[2].id);
  check('empty tag → []', chat.parseTwitchEmotesTag('').length === 0);
}

/* -------------------------------------------------------------------------- */
console.log('\nbuildTwitchSegments — code-point ranges');
/* -------------------------------------------------------------------------- */

{
  const text = 'Kappa hi';
  const segs = chat.buildTwitchSegments(text, chat.parseTwitchEmotesTag('25:0-4'));
  check('emote then text', segs.length === 2 && segs[0].kind === 'emote' && segs[1].kind === 'text',
    segs.map((s) => s.kind).join(','));
  check('emote name is the ranged text', segs[0].text === 'Kappa', segs[0].text);
  check('emote url on jtvnw host', /static-cdn\.jtvnw\.net/.test(segs[0].url || ''), segs[0].url);
  check('trailing text kept', segs[1].text === ' hi', JSON.stringify(segs[1].text));
}
{
  // The critical case: an astral emoji BEFORE the emote. The range 3-7 is in
  // code points, so indexing by UTF-16 (where the emoji is 2 units) would grab
  // the wrong slice. Array.from must be used.
  const text = '😀 Kappa';
  // code points: [😀, ' ', K, a, p, p, a] → Kappa is 2..6
  const segs = chat.buildTwitchSegments(text, chat.parseTwitchEmotesTag('25:2-6'));
  const emote = segs.find((s) => s.kind === 'emote');
  check('emoji before emote does not shift the range', emote && emote.text === 'Kappa',
    emote && emote.text);
  check('leading text kept intact', segs[0].kind === 'text' && segs[0].text === '😀 ',
    segs[0] && JSON.stringify(segs[0].text));
}
{
  const plain = chat.buildTwitchSegments('just words', []);
  check('no emotes → one text segment', plain.length === 1 && plain[0].kind === 'text');
}

/* -------------------------------------------------------------------------- */
console.log('\ntwitchMessageFromIrc — full normalization');
/* -------------------------------------------------------------------------- */

{
  const line = chat.parseIrcLine(
    '@badges=moderator/1,subscriber/12;color=#00FF7F;display-name=Mod\\sChad;emotes=;id=xyz ' +
    ':chad!chad@chad.tmi.twitch.tv PRIVMSG #apex :nice lap',
  );
  const msg = chat.twitchMessageFromIrc(line, 1000);
  check('platform twitch', msg && msg.platform === 'twitch');
  check('author from display-name', msg && msg.author === 'Mod Chad', msg && msg.author);
  check('valid color kept', msg && msg.color === '#00FF7F', msg && msg.color);
  check('mod + member badges', msg && msg.badges.join(',') === 'mod,member', msg && msg.badges.join(','));
  check('id from tag', msg && msg.id === 'xyz', msg && msg.id);
  check('timestamp injected', msg && msg.ts === 1000, msg && msg.ts);
}
{
  // No color tag → empty string (the widget hashes a fallback), and a non-PRIVMSG
  // returns null rather than a blank message.
  const noColor = chat.twitchMessageFromIrc(
    chat.parseIrcLine(':a!a@a PRIVMSG #x :hi'),
    5,
  );
  check('missing color → empty string', noColor && noColor.color === '', noColor && `"${noColor.color}"`);
  check('author falls back to nick', noColor && noColor.author === 'a', noColor && noColor.author);
  const join = chat.twitchMessageFromIrc(chat.parseIrcLine(':a!a@a JOIN #x'), 5);
  check('non-PRIVMSG → null', join === null);
}
{
  // A bogus color tag must not reach the DOM as a style — it is dropped to ''.
  const bad = chat.twitchMessageFromIrc(
    chat.parseIrcLine('@color=red;display-name=X :x!x@x PRIVMSG #c :hey'),
    1,
  );
  check('invalid color rejected', bad && bad.color === '', bad && `"${bad.color}"`);
}

/* -------------------------------------------------------------------------- */
console.log('\nnormalizeTwitchChannel');
/* -------------------------------------------------------------------------- */

check('bare login lowercased', chat.normalizeTwitchChannel('ApexRacer') === 'apexracer');
check('# stripped', chat.normalizeTwitchChannel('#apex') === 'apex');
check('full URL reduced to login', chat.normalizeTwitchChannel('https://twitch.tv/Apex_Racer') === 'apex_racer',
  chat.normalizeTwitchChannel('https://twitch.tv/Apex_Racer'));
check('junk stripped', chat.normalizeTwitchChannel('  apex!! ') === 'apex', chat.normalizeTwitchChannel('  apex!! '));
check('empty stays empty', chat.normalizeTwitchChannel('') === '' && chat.normalizeTwitchChannel(null) === '');

/* -------------------------------------------------------------------------- */
console.log('\nnormalizeYouTubeItem');
/* -------------------------------------------------------------------------- */

{
  const item = {
    id: 'yt-1',
    snippet: { type: 'textMessageEvent', displayMessage: 'gg wp' },
    authorDetails: { displayName: 'Viewer One', isChatOwner: true, isVerified: true },
  };
  const msg = chat.normalizeYouTubeItem(item, 2000);
  check('platform youtube', msg && msg.platform === 'youtube');
  check('single text segment', msg && msg.segments.length === 1 && msg.segments[0].text === 'gg wp',
    msg && msg.segments.length);
  check('owner → broadcaster badge', msg && msg.badges.indexOf('broadcaster') !== -1,
    msg && msg.badges.join(','));
  check('verified badge', msg && msg.badges.indexOf('verified') !== -1, msg && msg.badges.join(','));
  check('no color from youtube', msg && msg.color === '', msg && `"${msg.color}"`);
  check('id + ts', msg && msg.id === 'yt-1' && msg.ts === 2000);
}
{
  // A membership/super-chat event is NOT a text line — skipped, not rendered.
  const gift = {
    id: 'yt-2',
    snippet: { type: 'newSponsorEvent', displayMessage: '' },
    authorDetails: { displayName: 'Gifter' },
  };
  check('non-text event → null', chat.normalizeYouTubeItem(gift, 1) === null);
  const blank = {
    id: 'yt-3',
    snippet: { type: 'textMessageEvent', displayMessage: '' },
    authorDetails: { displayName: 'Nobody' },
  };
  check('empty text → null', chat.normalizeYouTubeItem(blank, 1) === null);
}

/* -------------------------------------------------------------------------- */
console.log('\nJsonArrayStreamParser — the streamList wire framing');
/* -------------------------------------------------------------------------- */

{
  // The shape the endpoint actually sends: ONE top-level array, delivered
  // chunked, whose elements arrive minutes apart over a live broadcast. The
  // framing was confirmed against the live endpoint, whose error body comes
  // back as `[{ … }\n]` under Transfer-Encoding: chunked.
  const p = new chat.JsonArrayStreamParser();
  const got = p.push('[{"a":1}');
  check('element completes without waiting for the array to close',
    got.length === 1 && got[0].a === 1, JSON.stringify(got));
  check('a separator alone yields nothing', p.push('\n,').length === 0);
  const second = p.push('{"a":2}\n]');
  check('second element after the separator', second.length === 1 && second[0].a === 2,
    JSON.stringify(second));
}
{
  // A chunk boundary can fall ANYWHERE — including mid-key. This is the failure
  // that would look like "chat works for a while, then stops".
  const p = new chat.JsonArrayStreamParser();
  check('split mid-key yields nothing yet', p.push('[{"nextPag').length === 0);
  check('still nothing mid-object', p.push('eToken":"abc","items":[').length === 0);
  const out = p.push('{"id":"m1"}]}');
  check('reassembled across three chunks',
    out.length === 1 && out[0].nextPageToken === 'abc' && out[0].items[0].id === 'm1',
    JSON.stringify(out));
}
{
  // The case that desynchronises a naive brace counter: a chat message full of
  // braces and quotes. Someone will absolutely type this.
  const p = new chat.JsonArrayStreamParser();
  const msg = 'gg {} }}{ "quoted" end';
  const payload = JSON.stringify({ items: [{ snippet: { displayMessage: msg } }] });
  const out = p.push('[' + payload);
  check('braces inside a string do not break framing', out.length === 1, out.length);
  check('the message survives intact',
    out.length === 1 && out[0].items[0].snippet.displayMessage === msg,
    out.length === 1 && JSON.stringify(out[0].items[0].snippet.displayMessage));
}
{
  // A backslash immediately before the closing quote — the classic escape-state
  // bug, where `\\` is misread as escaping the quote and the parser runs on.
  const p = new chat.JsonArrayStreamParser();
  const out = p.push('[{"t":"back\\\\"}');
  check('an escaped backslash does not swallow the closing quote',
    out.length === 1 && out[0].t === 'back\\', JSON.stringify(out));
}
{
  // Several elements can land in one read; all must come out, in order.
  const p = new chat.JsonArrayStreamParser();
  const out = p.push('[{"n":1},{"n":2},{"n":3}');
  check('three elements from one chunk', out.length === 3, out.length);
  check('order preserved', out.map((o) => o.n).join(',') === '1,2,3',
    out.map((o) => o.n).join(','));
}
{
  // A broadcast runs for hours. The separators walked past must not accumulate.
  const p = new chat.JsonArrayStreamParser();
  for (let i = 0; i < 500; i++) p.push(`{"n":${i}}\n,`);
  check('buffer does not grow across many elements', p.pendingBytes() === 0, p.pendingBytes());
}
{
  // Garbage must not wedge the parser forever — the next good element still
  // parses, because a stream that gives up on one bad frame is a dead chat.
  const p = new chat.JsonArrayStreamParser();
  p.push('[{"broken":}');
  const out = p.push(',{"ok":true}');
  check('recovers after a malformed element', out.length === 1 && out[0].ok === true,
    JSON.stringify(out));
}

/* -------------------------------------------------------------------------- */
console.log('\nSafety contract — emote hosts + a fresh hub');
/* -------------------------------------------------------------------------- */

{
  // The widget re-checks emote URLs against this exact list before setting an
  // <img> src, so the two must agree on it.
  check('jtvnw is an allowed emote host', chat.EMOTE_HOSTS.indexOf('static-cdn.jtvnw.net') !== -1);
  check('emote host list is frozen', Object.isFrozen(chat.EMOTE_HOSTS));
  check('twitchEmoteUrl builds from id only',
    chat.twitchEmoteUrl('301') === 'https://static-cdn.jtvnw.net/emoticons/v2/301/default/dark/1.0',
    chat.twitchEmoteUrl('301'));
}
{
  // Constructing a hub must not open any socket (no network at rest). It is
  // inactive and empty until a source is configured.
  const hub = new chat.ChatHub();
  check('fresh hub is inactive', hub.active === false);
  check('fresh hub snapshot empty', Array.isArray(hub.snapshot()) && hub.snapshot().length === 0);
  hub.stop();
}

/* -------------------------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
