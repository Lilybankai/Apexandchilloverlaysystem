/**
 * @file src/server/streamBot.ts
 * @module server/streamBot
 *
 * The **stream bot**: reacts to the merged chat feed (`ChatHub`) with command
 * replies, timed messages, support-event alerts and goal announcements, on the
 * streamer's own accounts (Twitch via the authenticated IRC client, YouTube via
 * `liveChatMessages.insert`).
 *
 * ## Why this is a pure class with injected callbacks
 * Same shape as the rest of `src/server`: everything that is easy to get
 * quietly wrong — cooldown arithmetic, timer cadence, the YouTube quota budget,
 * gift-bomb double counting — is deterministic logic driven by an injected
 * clock, so `scripts/test-streambot.js` can exercise a whole stream's worth of
 * behaviour in milliseconds with no sockets and no Google project. The actual
 * I/O (an IRC PRIVMSG, an HTTPS insert) arrives as constructor callbacks wired
 * up in `src/server/index.ts`.
 *
 * ## The YouTube budget is a hard wall, not a suggestion
 * `liveChatMessages.insert` costs **50 quota units per message** against the
 * 10,000/day Cloud-project quota that every install of the app shares (see
 * docs/youtube-chat-quota.md). Until the quota extension lands, one chatty bot
 * could starve every other user's chat widget. So YouTube sends pass through
 * {@link YouTubeBudget}: session and daily caps, with the cheap traffic shed
 * first — timers stop at 25% budget remaining, command replies at 10%, and
 * alerts (the messages a human notices missing) run to zero. Twitch has no
 * comparable cost, so it only gets the anti-spam floors.
 */

'use strict';

import type { ChatMessage, ChatEventKind } from './chatHub';

/* -------------------------------------------------------------------------- */
/*  Config shapes (mirrored by electron/streamBot.js, which owns persistence)  */
/* -------------------------------------------------------------------------- */

export interface BotCommand {
  id: string;
  /** The `!name` (stored without the `!`). Matched case-insensitively. */
  name: string;
  response: string;
  cooldownSec: number;
  enabled: boolean;
}

export interface BotTimer {
  id: string;
  text: string;
  intervalMin: number;
  /** Only speak while the platform is actually live (YouTube always is: no liveChatId, no send). */
  onlyWhileLive: boolean;
  platforms: { twitch: boolean; youtube: boolean };
  enabled: boolean;
}

/** The alert vocabulary the panel configures. Twitch subgift + giftbomb share 'gift'. */
export type AlertKey = 'sub' | 'resub' | 'gift' | 'membership' | 'superchat';

export interface AlertConfig {
  enabled: boolean;
  template: string;
}

export interface Goal {
  id: string;
  type: 'twitch_subs' | 'yt_members';
  label: string;
  target: number;
  current: number;
  /** Announce progress every N increments (as well as at completion). */
  announceEveryN: number;
  enabled: boolean;
  templates: { progress: string; complete: string };
}

/** What the desktop app pushes down; recomputed and re-pushed on every change. */
export interface StreamBotConfig {
  enabled: boolean;
  platforms: { twitch: boolean; youtube: boolean };
  commands: BotCommand[];
  timers: BotTimer[];
  alerts: Partial<Record<AlertKey, AlertConfig>>;
  goals: Goal[];
  youtube: {
    sendAllowed: boolean;
    sessionCap: number;
    dailyCap: number;
    usedSession: number;
    usedToday: number;
    minTimerIntervalMs: number;
  };
  twitch: { sendAllowed: boolean; minTimerIntervalMs: number };
  /** The linked accounts' own display/login names — the echo-loop guard. */
  selfNames: { twitch?: string; youtube?: string };
}

/* -------------------------------------------------------------------------- */
/*  Pure helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Fill `{user}`-style placeholders. Unknown placeholders are left literal so a
 * typo is visible in chat rather than silently swallowed.
 */
export function renderTemplate(template: string, vars: Record<string, string | number | undefined>): string {
  return String(template || '').replace(/\{(\w+)\}/g, (whole, key: string) => {
    const v = vars[key];
    return v === undefined || v === null ? whole : String(v);
  });
}

/** First-token `!command` name from a chat line ('' when it isn't one). */
export function commandNameFromText(text: string): string {
  const m = /^!([a-zA-Z0-9_]+)\b/.exec(String(text || '').trim());
  return m && m[1] ? m[1].toLowerCase() : '';
}

/** The plain text of a message (segments joined; emotes as their names). */
export function messageText(msg: ChatMessage): string {
  return (msg.segments || []).map((s) => s.text).join('');
}

/** Which alert a chat event maps to. */
export function alertKeyForEvent(kind: ChatEventKind): AlertKey {
  if (kind === 'subgift' || kind === 'giftbomb') return 'gift';
  if (kind === 'sub') return 'sub';
  if (kind === 'resub') return 'resub';
  if (kind === 'membership') return 'membership';
  return 'superchat';
}

/**
 * The YouTube send budget. **A cap of 0 means uncapped — and that is the
 * default**: the bot never limits a chat unless the streamer sets a cap
 * themselves. When caps ARE set, `sessionCap` guards one stream from burning
 * the day, `dailyCap` guards the day itself, and priorities shed the cheap
 * traffic first — see the module doc. All counts are messages (1 msg = 50
 * quota units; Google's own shared 10k/day still applies either way).
 */
export class YouTubeBudget {
  private sessionCap = 0;
  private dailyCap = 0;
  private usedSession = 0;
  private usedToday = 0;

  public configure(cfg: { sessionCap: number; dailyCap: number; usedSession: number; usedToday: number }): void {
    this.sessionCap = Math.max(0, Math.floor(cfg.sessionCap || 0));
    this.dailyCap = Math.max(0, Math.floor(cfg.dailyCap || 0));
    this.usedSession = Math.max(0, Math.floor(cfg.usedSession || 0));
    this.usedToday = Math.max(0, Math.floor(cfg.usedToday || 0));
  }

  /**
   * The scarcer configured window, as a fraction of budget remaining. A cap of
   * 0 is "no cap" and simply doesn't take part; no caps at all is 1 (plenty).
   */
  public remainingFraction(): number {
    let fraction = 1;
    if (this.sessionCap > 0) {
      fraction = Math.min(fraction, Math.max(0, this.sessionCap - this.usedSession) / this.sessionCap);
    }
    if (this.dailyCap > 0) {
      fraction = Math.min(fraction, Math.max(0, this.dailyCap - this.usedToday) / this.dailyCap);
    }
    return fraction;
  }

  /** Messages left in the scarcer configured window; Infinity when uncapped. */
  public remainingMessages(): number {
    let remaining = Number.POSITIVE_INFINITY;
    if (this.sessionCap > 0) remaining = Math.min(remaining, this.sessionCap - this.usedSession);
    if (this.dailyCap > 0) remaining = Math.min(remaining, this.dailyCap - this.usedToday);
    return Math.max(0, remaining);
  }

  public canSend(priority: 'alert' | 'command' | 'timer'): boolean {
    const fraction = this.remainingFraction();
    if (this.remainingMessages() <= 0) return false;
    if (priority === 'timer') return fraction > 0.25;
    if (priority === 'command') return fraction > 0.1;
    return true; // alerts spend down to zero
  }

  /** Record one sent message (the authoritative ledger lives in the app). */
  public noteSend(): void {
    this.usedSession++;
    this.usedToday++;
  }
}

/* -------------------------------------------------------------------------- */
/*  The bot                                                                    */
/* -------------------------------------------------------------------------- */

/** Minimum gap between any two bot lines on one platform (anti-burst floor). */
const GLOBAL_FLOOR_MS = 2000;

/**
 * After a Twitch gift bomb (`submysterygift`), Twitch also sends one `subgift`
 * USERNOTICE per recipient. Within this window those are the bomb's shrapnel:
 * they neither alert (the bomb already did) nor increment goals (the bomb's
 * `count` already covered them).
 */
const GIFTBOMB_SUPPRESS_MS = 30_000;

/**
 * How long a line the bot just sent is treated as its own echo (ms). Because
 * the bot speaks AS the streamer, its replies come back down the chat feed
 * authored by the streamer — and only those exact lines must be ignored, so a
 * reply that happens to start with `!` can't re-trigger a command forever.
 * The streamer TYPING a command themselves is normal use and must work.
 */
const ECHO_WINDOW_MS = 15_000;

export interface StreamBotDeps {
  now?: () => number;
  /** Queue a Twitch line; false when the IRC side can't send at all. */
  sendTwitch: (text: string) => boolean;
  /** Insert a YouTube line; resolves false on failure. Never called over budget. */
  sendYouTube: (text: string) => Promise<boolean>;
  /** One successful YouTube insert happened — persist it in the quota ledger. */
  onQuotaUsed: (messages: number) => void;
  /** A goal's `current` moved (event-driven) — persist it. */
  onGoalChanged: (goalId: string, current: number) => void;
  isLive: (platform: 'twitch' | 'youtube') => boolean;
}

export class StreamBot {
  private cfg: StreamBotConfig | null = null;
  private readonly deps: StreamBotDeps;
  private readonly now: () => number;
  private readonly budget = new YouTubeBudget();
  /** Per-command last-fired (key `id`). */
  private readonly commandFiredAt = new Map<string, number>();
  /** Per-timer, per-platform last-fired (key `id:platform`). */
  private readonly timerFiredAt = new Map<string, number>();
  /** Per-platform last bot line of any kind (the global floor). */
  private readonly lastSendAt: { twitch: number; youtube: number } = {
    twitch: Number.NEGATIVE_INFINITY,
    youtube: Number.NEGATIVE_INFINITY,
  };
  /** Lines the bot recently dispatched, to recognise them coming back. */
  private readonly recentSends: Array<{ platform: 'twitch' | 'youtube'; text: string; at: number }> = [];
  private giftBombAt = 0;

  public constructor(deps: StreamBotDeps) {
    this.deps = deps;
    this.now = deps.now || Date.now;
  }

  public setConfig(cfg: StreamBotConfig): void {
    this.cfg = cfg;
    this.budget.configure(cfg.youtube);
  }

  public stop(): void {
    this.cfg = null;
  }

  /* ------------------------------- inbound -------------------------------- */

  public handleMessage(msg: ChatMessage): void {
    const cfg = this.cfg;
    if (!cfg || !cfg.enabled) return;
    if (!cfg.platforms[msg.platform]) return;

    if (msg.event) {
      this.handleEvent(msg);
      return;
    }

    // The bot speaks as the streamer, so its own replies come back authored by
    // the streamer. Drop ONLY those exact echoed lines — the streamer typing a
    // command themselves is the normal way commands get shown to chat.
    if (this.isSelf(msg) && this.isRecentEcho(msg.platform, messageText(msg).trim())) return;

    const name = commandNameFromText(messageText(msg));
    if (!name) return;
    const command = cfg.commands.find((c) => c.enabled && c.name.toLowerCase() === name);
    if (!command) return;

    const t = this.now();
    const last = this.commandFiredAt.get(command.id);
    const cooldownMs = Math.max(0, command.cooldownSec || 0) * 1000;
    if (last !== undefined && t - last < cooldownMs) return;

    if (this.say(msg.platform, command.response, 'command')) {
      this.commandFiredAt.set(command.id, t);
    }
  }

  private handleEvent(msg: ChatMessage): void {
    const cfg = this.cfg;
    const event = msg.event;
    if (!cfg || !event) return;
    const t = this.now();

    // Gift-bomb shrapnel: the per-recipient subgift notices that follow a
    // submysterygift are already covered by the bomb itself.
    if (event.kind === 'giftbomb') this.giftBombAt = t;
    if (event.kind === 'subgift' && t - this.giftBombAt < GIFTBOMB_SUPPRESS_MS) return;

    const key = alertKeyForEvent(event.kind);
    const alert = cfg.alerts[key];
    if (alert && alert.enabled && alert.template) {
      const text = renderTemplate(alert.template, {
        user: msg.author,
        tier: event.tier,
        months: event.months,
        count: event.count,
        amount: event.amount,
      });
      this.say(msg.platform, text, 'alert');
    }

    // Event-driven goal increments.
    const goalType =
      event.kind === 'sub' || event.kind === 'subgift' || event.kind === 'giftbomb'
        ? 'twitch_subs'
        : event.kind === 'membership'
          ? 'yt_members'
          : null;
    if (!goalType) return;
    const step = event.kind === 'giftbomb' ? Math.max(1, event.count || 1) : 1;
    for (const goal of cfg.goals) {
      if (!goal.enabled || goal.type !== goalType) continue;
      const before = goal.current;
      goal.current = Math.max(0, before + step);
      this.deps.onGoalChanged(goal.id, goal.current);
      this.announceGoal(goal, before, msg.platform);
    }
  }

  /** Progress lines on every announceEveryN boundary crossed; complete once. */
  private announceGoal(goal: Goal, before: number, platform: 'twitch' | 'youtube'): void {
    const vars = { label: goal.label, current: goal.current, target: goal.target };
    if (before < goal.target && goal.current >= goal.target) {
      this.say(platform, renderTemplate(goal.templates.complete, vars), 'alert');
      return;
    }
    const n = Math.max(1, goal.announceEveryN || 1);
    if (goal.current < goal.target && Math.floor(goal.current / n) > Math.floor(before / n)) {
      this.say(platform, renderTemplate(goal.templates.progress, vars), 'alert');
    }
  }

  /* ------------------------------- timers --------------------------------- */

  /** Drive timed messages. Called every few seconds by the server. */
  public tick(): void {
    const cfg = this.cfg;
    if (!cfg || !cfg.enabled) return;
    const t = this.now();
    for (const timer of cfg.timers) {
      if (!timer.enabled || !timer.text) continue;
      for (const platform of ['twitch', 'youtube'] as const) {
        if (!timer.platforms[platform] || !cfg.platforms[platform]) continue;
        if (timer.onlyWhileLive !== false && !this.deps.isLive(platform)) continue;
        const minMs = platform === 'youtube' ? cfg.youtube.minTimerIntervalMs : cfg.twitch.minTimerIntervalMs;
        const intervalMs = Math.max(Math.max(1, timer.intervalMin) * 60_000, minMs);
        const key = `${timer.id}:${platform}`;
        let last = this.timerFiredAt.get(key);
        if (last === undefined) {
          // First sighting: start the clock now rather than firing immediately,
          // so enabling a timer doesn't instantly speak into a quiet chat.
          this.timerFiredAt.set(key, t);
          last = t;
        }
        if (t - last < intervalMs) continue;
        if (this.say(platform, timer.text, 'timer')) {
          this.timerFiredAt.set(key, t);
        }
      }
    }
  }

  /* ------------------------------- outbound ------------------------------- */

  /**
   * Send one line, respecting platform enablement, the global floor and (for
   * YouTube) the quota budget. Returns whether the line was actually dispatched
   * (YouTube: queued for dispatch — the insert is async).
   */
  private say(platform: 'twitch' | 'youtube', text: string, priority: 'alert' | 'command' | 'timer'): boolean {
    const cfg = this.cfg;
    const line = String(text || '').trim();
    if (!cfg || !line || !cfg.platforms[platform]) return false;
    const t = this.now();
    // The floor is an anti-burst guard on viewer-triggered and scheduled
    // traffic. Alerts are exempt: a sub alert followed a beat later by its goal
    // line is the intended shape, and the wire is still protected (Twitch by
    // the IRC rate limiter, YouTube by the budget).
    if (priority !== 'alert' && t - this.lastSendAt[platform] < GLOBAL_FLOOR_MS) return false;

    if (platform === 'twitch') {
      if (!cfg.twitch.sendAllowed) return false;
      if (!this.deps.sendTwitch(line)) return false;
      this.lastSendAt.twitch = t;
      this.noteSent('twitch', line, t);
      return true;
    }

    if (!cfg.youtube.sendAllowed || !this.deps.isLive('youtube')) return false;
    if (!this.budget.canSend(priority)) return false;
    // Spend (and persist) at dispatch, not on the response: a concurrent tick
    // must not double-spend the slot while the insert is in flight, and if the
    // insert fails the ledger overcounts by one — the safe direction for a
    // quota that other installs share.
    this.budget.noteSend();
    this.deps.onQuotaUsed(1);
    this.lastSendAt.youtube = t;
    this.noteSent('youtube', line, t);
    void this.deps.sendYouTube(line).catch(() => {});
    return true;
  }

  /** Public snapshot for status surfaces. */
  public budgetRemaining(): number {
    return this.budget.remainingMessages();
  }

  /** Remember a dispatched line so its echo can be recognised. */
  private noteSent(platform: 'twitch' | 'youtube', text: string, at: number): void {
    this.recentSends.push({ platform, text, at });
    while (this.recentSends.length > 30) this.recentSends.shift();
  }

  /** Whether this exact line was dispatched by us inside the echo window. */
  private isRecentEcho(platform: 'twitch' | 'youtube', text: string): boolean {
    const cutoff = this.now() - ECHO_WINDOW_MS;
    while (this.recentSends.length > 0 && (this.recentSends[0]?.at ?? 0) < cutoff) this.recentSends.shift();
    return this.recentSends.some((s) => s.platform === platform && s.text === text);
  }

  private isSelf(msg: ChatMessage): boolean {
    const self = this.cfg?.selfNames;
    if (!self) return false;
    const author = msg.author.trim().toLowerCase();
    if (!author) return false;
    const own = msg.platform === 'twitch' ? self.twitch : self.youtube;
    return !!own && own.trim().toLowerCase() === author;
  }
}

/* -------------------------------------------------------------------------- */
/*  The YouTube insert (the only I/O in this module, kept separately callable) */
/* -------------------------------------------------------------------------- */

/**
 * Post one message into a YouTube live chat. Costs 50 quota units — callers go
 * through {@link YouTubeBudget}, never here directly. Returns true on success;
 * a 401 is reported through `onAuthError` exactly like the readers do.
 */
export async function insertYouTubeChatMessage(opts: {
  liveChatId: string;
  accessToken: string;
  text: string;
  base?: string;
  onAuthError?: () => void;
}): Promise<boolean> {
  const { liveChatId, accessToken, text } = opts;
  if (!liveChatId || !accessToken || !text) return false;
  const base = opts.base || 'https://www.googleapis.com/youtube/v3';
  try {
    const res = await fetch(`${base}/liveChat/messages?part=snippet`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        snippet: {
          liveChatId,
          type: 'textMessageEvent',
          textMessageDetails: { messageText: text.slice(0, 200) },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401) {
      opts.onAuthError?.();
      return false;
    }
    return res.ok;
  } catch {
    return false;
  }
}
