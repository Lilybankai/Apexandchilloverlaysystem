/**
 * @file src/server/chatHub.ts
 * @module server/chatHub
 *
 * The **live-chat hub**: it pulls a streamer's YouTube and Twitch chat into one
 * normalized stream, so the overlay's chat widget can render both without
 * knowing anything about either platform's wire format.
 *
 * ## Why the fetching lives here (server-side), not in the widget
 * The overlay follows a strict "the widget is a dumb renderer" rule (see
 * `overlay/js/widgets/radar.js` — the projection lives in `telemetry/radar.ts`,
 * the widget only draws). Chat is the same shape of problem: two platforms with
 * very different access models collapse to one on-screen list. Normalizing here
 * keeps the widget tiny, keeps every credential off the browser, and means the
 * SAME normalized feed reaches both hosts the overlay runs in — an OBS Browser
 * Source and the in-game layer — over one WebSocket (`/chat`), exactly as the
 * telemetry frame does over `/ws`.
 *
 * ## The two platforms are deliberately asymmetric
 * - **Twitch** is read anonymously over IRC-over-WebSocket
 *   (`wss://irc-ws.chat.twitch.tv`) as a `justinfan` guest. No OAuth, no
 *   credential, no cost beyond an idle socket — you only need the channel name.
 *   This is why a Twitch-only setup works from a bare `npm start` with one env
 *   var.
 * - **YouTube** has no anonymous chat read. It needs the Data API v3
 *   (`liveChatMessages.list`) with an OAuth access token and the broadcast's
 *   `liveChatId`. Both are handed in from the desktop app, which owns the Google
 *   sign-in (see `electron/chatLink.js`) — the token never reaches this module's
 *   callers, only its poller. The API tells us how often to poll
 *   (`pollingIntervalMillis`); we obey it rather than guess, which is what keeps
 *   a multi-hour stream inside the daily quota.
 *
 * Everything in this file works with the dependencies the project already has:
 * `ws` (a direct dependency) for the Twitch socket and Node 18's built-in
 * `fetch` for the YouTube REST calls. No new runtime dependency for a chat feed.
 *
 * The parsing/normalization functions are exported and pure so they can be
 * tested headlessly (see `scripts/test-chat.js`) — the part that is easy to get
 * quietly wrong (IRCv3 tag parsing, emote code-point ranges) is exactly the part
 * that never shows up on a screenshot until it renders one message mangled.
 */

'use strict';

import { WebSocket } from 'ws';

/* -------------------------------------------------------------------------- */
/*  The normalized wire shape (one message, either platform)                  */
/* -------------------------------------------------------------------------- */

/** Which service a message came from. */
export type ChatPlatform = 'twitch' | 'youtube';

/**
 * A message is a list of segments so an emote can sit inline between words. The
 * widget renders `text` with `textContent` (never innerHTML) and an `emote`'s
 * image from `url` — the split is what lets the renderer stay XSS-safe without
 * having to sanitize a marked-up string.
 */
export interface ChatSegment {
  /** `text` is literal chat text; `emote` is a single inline image. */
  kind: 'text' | 'emote';
  /** For `text`, the literal run; for `emote`, the emote's name (its alt text). */
  text: string;
  /** For `emote` only: absolute image URL, always on an {@link EMOTE_HOSTS} host. */
  url?: string;
}

/**
 * A small, closed badge vocabulary shared across platforms — enough for the
 * widget to mark who is talking (the broadcaster, a mod, a paying member)
 * without carrying either platform's full badge zoo.
 */
export type ChatBadge = 'broadcaster' | 'mod' | 'vip' | 'member' | 'verified';

/** One normalized chat message, as broadcast on the `/chat` WebSocket. */
export interface ChatMessage {
  /** Platform message id — the dedupe key, so a replayed backlog never doubles. */
  id: string;
  platform: ChatPlatform;
  /** Display name as the platform gives it. */
  author: string;
  /** Author name colour as `#rrggbb`, or '' when the platform supplies none. */
  color: string;
  badges: ChatBadge[];
  segments: ChatSegment[];
  /** Server clock (ms epoch) when the hub received it — the widget's sort key. */
  ts: number;
}

/**
 * The only image hosts an emote URL may point at. The widget re-checks a URL's
 * host against this same list before it sets an `<img>` src, so a compromised or
 * spoofed feed cannot turn a chat line into an arbitrary outbound image request.
 * Kept here (and mirrored in the widget) as the single source of truth.
 */
export const EMOTE_HOSTS: readonly string[] = Object.freeze([
  'static-cdn.jtvnw.net', // Twitch emotes
  'yt3.ggpht.com', // YouTube custom emoji / channel art
  'www.youtube.com',
  'i.ytimg.com',
]);

/* -------------------------------------------------------------------------- */
/*  Twitch — anonymous IRC-over-WebSocket                                      */
/* -------------------------------------------------------------------------- */

/** Twitch emote image, built from the emote id — never from message content. */
export function twitchEmoteUrl(id: string): string {
  return `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(id)}/default/dark/1.0`;
}

/**
 * The pieces of one raw IRC line. `tags` is the IRCv3 `@k=v;...` map, `command`
 * is e.g. `PRIVMSG`/`PING`, `params` are the space-split arguments, and
 * `trailing` is the `:`-prefixed final argument (the message text for a
 * PRIVMSG). Anything absent is null/empty rather than undefined so callers can
 * branch on one shape.
 */
export interface IrcLine {
  tags: Record<string, string>;
  prefix: string;
  command: string;
  params: string[];
  trailing: string | null;
}

/**
 * Parse one raw IRC line into its parts.
 *
 * Hand-rolled rather than pulling an IRC library for the handful of message
 * shapes Twitch actually sends: a `@tags` block, an optional `:prefix`, a
 * command, middle params, and a `:trailing` argument. Tag values use IRCv3
 * escaping (`\s` space, `\:` semicolon, `\\` backslash, `\r`/`\n`), which is
 * unescaped here — miss it and a display name with a space arrives truncated.
 */
export function parseIrcLine(raw: string): IrcLine | null {
  let rest = raw.replace(/\r?\n$/, '');
  if (!rest) return null;

  const tags: Record<string, string> = {};
  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    if (sp === -1) return null;
    const tagStr = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
    for (const pair of tagStr.split(';')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const key = eq === -1 ? pair : pair.slice(0, eq);
      const val = eq === -1 ? '' : pair.slice(eq + 1);
      tags[key] = unescapeTagValue(val);
    }
  }

  let prefix = '';
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    if (sp === -1) return null;
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }

  // Split the command + params off the trailing (`:`-prefixed) argument.
  let trailing: string | null = null;
  const trailingIdx = rest.indexOf(' :');
  if (rest.startsWith(':')) {
    trailing = rest.slice(1);
    rest = '';
  } else if (trailingIdx !== -1) {
    trailing = rest.slice(trailingIdx + 2);
    rest = rest.slice(0, trailingIdx);
  }

  const parts = rest.split(' ').filter((p) => p.length > 0);
  const command = parts.shift() ?? '';
  if (!command) return null;

  return { tags, prefix, command, params: parts, trailing };
}

/** Undo IRCv3 tag-value escaping (`\s`, `\:`, `\\`, `\r`, `\n`). */
function unescapeTagValue(v: string): string {
  let out = '';
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '\\' && i + 1 < v.length) {
      const next = v[i + 1];
      out += next === 's' ? ' ' : next === ':' ? ';' : next === 'r' ? '\r' : next === 'n' ? '\n' : next;
      i++;
    } else {
      out += v[i];
    }
  }
  return out;
}

/**
 * The emote occurrences from a Twitch `emotes` tag, as `{id, start, end}` in
 * ascending start order. The tag is `id:start-end,start-end/id:start-end`, and
 * the indices are **code-point** offsets into the message, not UTF-16 — which is
 * why {@link buildTwitchSegments} walks the text with `Array.from`.
 */
export function parseTwitchEmotesTag(tag: string): Array<{ id: string; start: number; end: number }> {
  if (!tag) return [];
  const out: Array<{ id: string; start: number; end: number }> = [];
  for (const group of tag.split('/')) {
    const colon = group.indexOf(':');
    if (colon === -1) continue;
    const id = group.slice(0, colon);
    for (const range of group.slice(colon + 1).split(',')) {
      const dash = range.indexOf('-');
      if (dash === -1) continue;
      const start = Number.parseInt(range.slice(0, dash), 10);
      const end = Number.parseInt(range.slice(dash + 1), 10);
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
        out.push({ id, start, end });
      }
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/**
 * Split a message into text/emote segments using the parsed emote ranges.
 *
 * Works in code points (`Array.from`) because Twitch's ranges do: an emoji or
 * any astral character earlier in the line would otherwise shift every following
 * emote by one and paint the wrong words as pictures.
 */
export function buildTwitchSegments(
  text: string,
  emotes: Array<{ id: string; start: number; end: number }>,
): ChatSegment[] {
  if (emotes.length === 0) return text ? [{ kind: 'text', text }] : [];
  const chars = Array.from(text);
  const segments: ChatSegment[] = [];
  let cursor = 0;
  for (const e of emotes) {
    if (e.start < cursor || e.end >= chars.length) continue; // stale/overlapping
    if (e.start > cursor) {
      segments.push({ kind: 'text', text: chars.slice(cursor, e.start).join('') });
    }
    const name = chars.slice(e.start, e.end + 1).join('');
    segments.push({ kind: 'emote', text: name, url: twitchEmoteUrl(e.id) });
    cursor = e.end + 1;
  }
  if (cursor < chars.length) {
    segments.push({ kind: 'text', text: chars.slice(cursor).join('') });
  }
  return segments;
}

/** Map Twitch's `badges` tag keys to our shared vocabulary (dropping the rest). */
function twitchBadges(tag: string): ChatBadge[] {
  const out: ChatBadge[] = [];
  if (!tag) return out;
  for (const b of tag.split(',')) {
    const key = b.split('/')[0];
    if (key === 'broadcaster') out.push('broadcaster');
    else if (key === 'moderator') out.push('mod');
    else if (key === 'vip') out.push('vip');
    else if (key === 'subscriber' || key === 'founder') out.push('member');
    else if (key === 'partner') out.push('verified');
  }
  return out;
}

/**
 * Turn a parsed PRIVMSG line into a normalized {@link ChatMessage}, or null if
 * it is not a chat message we render. `nowMs` is injected so the test can pin a
 * timestamp.
 */
export function twitchMessageFromIrc(line: IrcLine, nowMs: number): ChatMessage | null {
  if (line.command !== 'PRIVMSG' || line.trailing === null) return null;
  const text = line.trailing;
  const author = line.tags['display-name']?.trim() || nickFromPrefix(line.prefix);
  if (!author) return null;
  const id = line.tags['id'] || `tw-${nowMs}-${Math.round(nowMs % 1000)}`;
  const color = /^#[0-9a-fA-F]{6}$/.test(line.tags['color'] || '') ? (line.tags['color'] as string) : '';
  const segments = buildTwitchSegments(text, parseTwitchEmotesTag(line.tags['emotes'] || ''));
  return {
    id,
    platform: 'twitch',
    author,
    color,
    badges: twitchBadges(line.tags['badges'] || ''),
    segments,
    ts: nowMs,
  };
}

/** The nick out of an IRC prefix (`nick!user@host`). */
function nickFromPrefix(prefix: string): string {
  const bang = prefix.indexOf('!');
  return bang === -1 ? prefix : prefix.slice(0, bang);
}

/** Normalize a Twitch channel to the bare, lower-cased login (no `#`, no URL). */
export function normalizeTwitchChannel(input: string): string {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return '';
  const m = /twitch\.tv\/([a-z0-9_]+)/.exec(s);
  if (m && m[1]) s = m[1];
  s = s.replace(/^#/, '').replace(/[^a-z0-9_]/g, '');
  return s;
}

/**
 * A read-only Twitch chat connection: an anonymous IRC-over-WebSocket client
 * that joins one channel and hands each parsed message to a callback.
 *
 * It reconnects with capped backoff (a stream is long; a dropped socket must
 * heal itself) and answers Twitch's `PING` with `PONG` (miss it and the server
 * closes the connection after a few minutes). Nothing here authenticates — the
 * `justinfan` nick is Twitch's documented anonymous guest, which can read a
 * public channel and do nothing else.
 */
export class TwitchChatClient {
  private ws: WebSocket | null = null;
  private channel = '';
  private closedByUs = false;
  private reconnectDelay = 1000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly onMessage: (msg: ChatMessage) => void;
  private readonly verbose: boolean;
  private readonly url: string;

  public constructor(opts: {
    onMessage: (msg: ChatMessage) => void;
    verbose?: boolean;
    url?: string;
  }) {
    this.onMessage = opts.onMessage;
    this.verbose = !!opts.verbose;
    this.url = opts.url || 'wss://irc-ws.chat.twitch.tv:443';
  }

  /** Connect to (or switch to) a channel. Passing '' disconnects. */
  public setChannel(channel: string): void {
    const next = normalizeTwitchChannel(channel);
    if (next === this.channel && (this.ws || !next)) return;
    this.channel = next;
    this.stop();
    if (next) this.connect();
  }

  public stop(): void {
    this.closedByUs = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        /* already gone */
      }
      this.ws = null;
    }
  }

  private connect(): void {
    if (!this.channel) return;
    this.closedByUs = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      if (this.verbose) console.error('[chat] twitch connect failed:', (err as Error).message);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectDelay = 1000;
      // Request tags (colour, emotes, badges, id) + commands, then join as an
      // anonymous guest. A random justinfan nick avoids two sources colliding.
      const nick = `justinfan${10000 + Math.floor((Date.now() % 89999))}`;
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send(`NICK ${nick}`);
      ws.send(`JOIN #${this.channel}`);
      if (this.verbose) console.log(`[chat] twitch joined #${this.channel}`);
    });

    ws.on('message', (data) => this.onData(data.toString()));
    ws.on('error', (err) => {
      if (this.verbose) console.error('[chat] twitch socket error:', err.message);
    });
    ws.on('close', () => {
      this.ws = null;
      if (!this.closedByUs) this.scheduleReconnect();
    });
  }

  private onData(chunk: string): void {
    // A single frame can carry several CRLF-separated lines.
    for (const raw of chunk.split('\r\n')) {
      if (!raw) continue;
      const line = parseIrcLine(raw);
      if (!line) continue;
      if (line.command === 'PING') {
        this.ws?.send(`PONG :${line.trailing ?? 'tmi.twitch.tv'}`);
        continue;
      }
      const msg = twitchMessageFromIrc(line, Date.now());
      if (msg) this.onMessage(msg);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closedByUs || !this.channel) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectTimer.unref?.();
    this.reconnectDelay = Math.min(30000, this.reconnectDelay * 2);
  }
}

/* -------------------------------------------------------------------------- */
/*  YouTube — Data API v3 live chat polling                                    */
/* -------------------------------------------------------------------------- */

/** A single item shape from `liveChatMessages.list` (only the fields we read). */
export interface YouTubeChatItem {
  id?: string;
  snippet?: {
    type?: string;
    displayMessage?: string;
  };
  authorDetails?: {
    displayName?: string;
    isChatOwner?: boolean;
    isChatModerator?: boolean;
    isChatSponsor?: boolean;
    isVerified?: boolean;
  };
}

/** Author booleans → our shared badge vocabulary. */
function youTubeBadges(a: NonNullable<YouTubeChatItem['authorDetails']>): ChatBadge[] {
  const out: ChatBadge[] = [];
  if (a.isChatOwner) out.push('broadcaster');
  if (a.isChatModerator) out.push('mod');
  if (a.isChatSponsor) out.push('member');
  if (a.isVerified) out.push('verified');
  return out;
}

/**
 * Normalize one YouTube live-chat item, or null when it is not a plain text
 * message (memberships, super-chats and the like are skipped for now — they are
 * events, not lines, and rendering them as text would misrepresent them).
 *
 * YouTube gives no per-author colour, so `color` is '' and the widget assigns a
 * stable colour by hashing the name — the same fallback it uses for a Twitch
 * user who has never set one. The message is a single text segment; YouTube's
 * custom emoji are left inline as their `:shortcut:` text in this first version.
 */
export function normalizeYouTubeItem(item: YouTubeChatItem, nowMs: number): ChatMessage | null {
  const snippet = item.snippet;
  const author = item.authorDetails;
  if (!snippet || !author) return null;
  if (snippet.type !== 'textMessageEvent') return null;
  const text = snippet.displayMessage || '';
  const name = (author.displayName || '').trim();
  if (!name || !text) return null;
  return {
    id: item.id || `yt-${nowMs}`,
    platform: 'youtube',
    author: name,
    color: '',
    badges: youTubeBadges(author),
    segments: [{ kind: 'text', text }],
    ts: nowMs,
  };
}

/**
 * Polls one YouTube live chat and forwards each new message.
 *
 * The API is explicit about cadence — every response carries a
 * `pollingIntervalMillis` — so the poller waits exactly that long before the
 * next call rather than inventing an interval. That is what keeps a long stream
 * inside the daily quota, and it is why this is a self-scheduling loop rather
 * than a `setInterval`.
 *
 * A 401 means the access token has expired; the poller stops and reports it
 * through `onAuthError` so the desktop app can refresh the token and hand back a
 * fresh one via {@link ChatHub.setConfig}. A 403 (quota / chat ended) backs off
 * hard rather than hammering a closed door.
 */
export class YouTubeChatPoller {
  private liveChatId = '';
  private accessToken = '';
  private pageToken = '';
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;
  private readonly onMessage: (msg: ChatMessage) => void;
  private readonly onAuthError: () => void;
  private readonly verbose: boolean;
  private readonly base: string;

  public constructor(opts: {
    onMessage: (msg: ChatMessage) => void;
    onAuthError?: () => void;
    verbose?: boolean;
    base?: string;
  }) {
    this.onMessage = opts.onMessage;
    this.onAuthError = opts.onAuthError || (() => {});
    this.verbose = !!opts.verbose;
    this.base = opts.base || 'https://www.googleapis.com/youtube/v3';
  }

  /** Point the poller at a chat (or clear it with an empty id/token). */
  public setTarget(liveChatId: string, accessToken: string): void {
    const id = String(liveChatId || '').trim();
    const token = String(accessToken || '').trim();
    const changed = id !== this.liveChatId || token !== this.accessToken;
    this.liveChatId = id;
    this.accessToken = token;
    if (!id || !token) {
      this.stop();
      return;
    }
    if (changed) {
      this.pageToken = '';
      this.stop();
      this.stopped = false;
      void this.poll();
    }
  }

  public stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, Math.max(1000, ms));
    this.timer.unref?.();
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.running || !this.liveChatId || !this.accessToken) return;
    this.running = true;
    try {
      const params = new URLSearchParams({
        liveChatId: this.liveChatId,
        part: 'snippet,authorDetails',
        maxResults: '200',
      });
      if (this.pageToken) params.set('pageToken', this.pageToken);
      const res = await fetch(`${this.base}/liveChat/messages?${params.toString()}`, {
        headers: { Authorization: `Bearer ${this.accessToken}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 401) {
        if (this.verbose) console.warn('[chat] youtube token expired');
        this.stop();
        this.onAuthError();
        return;
      }
      if (!res.ok) {
        if (this.verbose) console.warn(`[chat] youtube poll HTTP ${res.status}`);
        // Quota, chat ended, transient — back off well past the normal cadence.
        this.schedule(15000);
        return;
      }
      const body = (await res.json()) as {
        items?: YouTubeChatItem[];
        nextPageToken?: string;
        pollingIntervalMillis?: number;
      };
      this.pageToken = body.nextPageToken || this.pageToken;
      const now = Date.now();
      for (const item of body.items || []) {
        const msg = normalizeYouTubeItem(item, now);
        if (msg) this.onMessage(msg);
      }
      this.schedule(body.pollingIntervalMillis || 5000);
    } catch (err) {
      if (this.verbose) console.warn('[chat] youtube poll failed:', (err as Error).message);
      this.schedule(10000);
    } finally {
      this.running = false;
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  The hub — owns both clients, dedupes, and keeps a small replay buffer      */
/* -------------------------------------------------------------------------- */

/** Live configuration for the hub. Any field may change at runtime. */
export interface ChatConfig {
  /** Twitch channel login (or URL / `#name` — normalized on the way in). */
  twitchChannel?: string;
  /** YouTube live chat id, discovered by the desktop app's Google sign-in. */
  youTubeLiveChatId?: string;
  /** YouTube OAuth access token for the polling calls. */
  youTubeAccessToken?: string;
}

/**
 * How many recent messages the hub keeps to replay to a newly-connected overlay,
 * so a source added mid-stream is not blank until the next message. Small on
 * purpose — a chat column only shows a dozen or so lines, and the buffer is
 * memory the hub holds for the whole session.
 */
const REPLAY_BUFFER = 60;

/** Remember this many recent ids to drop duplicates (replayed backlog, retries). */
const DEDUPE_WINDOW = 400;

/**
 * Fans YouTube + Twitch into one normalized, de-duplicated stream and keeps a
 * short replay buffer. The transport (the `/chat` WebSocket) subscribes with
 * {@link onMessage}; nothing here knows about sockets, which keeps the hub
 * testable and lets the same instance feed a different transport later.
 */
export class ChatHub {
  private readonly twitch: TwitchChatClient;
  private readonly youtube: YouTubeChatPoller;
  private readonly buffer: ChatMessage[] = [];
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly listeners = new Set<(msg: ChatMessage) => void>();
  private config: ChatConfig = {};
  /** Called when YouTube reports its token expired, so the app can refresh it. */
  public onYouTubeAuthError: () => void = () => {};

  public constructor(opts: { verbose?: boolean } = {}) {
    const verbose = !!opts.verbose;
    this.twitch = new TwitchChatClient({ verbose, onMessage: (m) => this.ingest(m) });
    this.youtube = new YouTubeChatPoller({
      verbose,
      onMessage: (m) => this.ingest(m),
      onAuthError: () => this.onYouTubeAuthError(),
    });
  }

  /** Subscribe to the merged feed. Returns an unsubscribe function. */
  public onMessage(cb: (msg: ChatMessage) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** The recent messages, oldest first, for replay to a new client. */
  public snapshot(): ChatMessage[] {
    return this.buffer.slice();
  }

  /** Apply new configuration; only the parts that changed restart their client. */
  public setConfig(next: ChatConfig): void {
    this.config = { ...this.config, ...next };
    this.twitch.setChannel(this.config.twitchChannel || '');
    this.youtube.setTarget(this.config.youTubeLiveChatId || '', this.config.youTubeAccessToken || '');
  }

  public getConfig(): ChatConfig {
    return { ...this.config };
  }

  /** Whether either source is currently configured. */
  public get active(): boolean {
    return !!(this.config.twitchChannel || (this.config.youTubeLiveChatId && this.config.youTubeAccessToken));
  }

  public stop(): void {
    this.twitch.stop();
    this.youtube.stop();
  }

  /* ------------------------------ internals ------------------------------ */

  private ingest(msg: ChatMessage): void {
    if (this.seen.has(msg.id)) return;
    this.seen.add(msg.id);
    this.seenOrder.push(msg.id);
    if (this.seenOrder.length > DEDUPE_WINDOW) {
      const evicted = this.seenOrder.shift();
      if (evicted) this.seen.delete(evicted);
    }
    this.buffer.push(msg);
    if (this.buffer.length > REPLAY_BUFFER) this.buffer.shift();
    for (const cb of this.listeners) {
      try {
        cb(msg);
      } catch {
        /* one dead listener must not stall the feed */
      }
    }
  }
}
