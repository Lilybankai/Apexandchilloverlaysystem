# YouTube live chat and the daily quota

The short version: **the quota ceiling is per Google Cloud project, not per
user.** Every installed copy of the app authenticates against the one OAuth
client baked into the build, so all of them draw down the same 10,000 units a
day. One streamer can exhaust it for everybody.

This document exists because that was not obvious from the outside — the
symptom was "one person is using chat and we're rate limited" — and because the
endpoint we now depend on is under-documented enough that finding it again from
scratch would cost another evening.

## What it used to cost

`liveChatMessages.list` costs **5 quota units per call**. Google's public quota
table does not list the Live Streaming methods at all, so this was established
from our own Cloud metrics: over 16 Jul – 13 Aug the project made 14,318
requests, essentially all to `V3DataLiveChatMessageService.List`, and hit the
10,000-unit ceiling on at least three separate days. At 1 unit a call three
capped days alone would need 30,000 requests, which is more than the month's
total; at 5 units a capped day is ~2,006 requests, which fits.

The poller obeyed the `pollingIntervalMillis` each response asked for — usually
~5s — which is the *right* thing to do and still worked out at:

| | requests | units |
|---|---|---|
| per hour | 720 | 3,600 |
| 3-hour stream | 2,160 | **10,800** |

So a single three-hour broadcast spent slightly more than the entire daily
allowance, regardless of how busy the chat was. Cost is per poll, not per
message; a silent chat cost exactly as much as a flooded one.

On top of that, `electron/chatLink.js` called `liveBroadcasts.list` every 60
seconds — 1,440 units/day per install, ~14% of the whole project quota — whether
or not the operator was live, and even while a chat was already streaming and
the answer could not have changed.

## What it costs now

`liveChatMessages.streamList` opens a **server-streaming connection**: one
request, held open for the length of the broadcast, with YouTube pushing
messages down it as they are posted. The `list` reference page now points at it
explicitly as the way to avoid exhausting your quota. One connection replaces
~720 calls an hour, and messages arrive faster than a 5-second poll allowed.

Rediscovery is now event-driven: every 5 minutes while nothing is on air, never
while a chat is live, and immediately when the server reports the chat ended.

## The endpoint, and how it was found

```
GET https://www.googleapis.com/youtube/v3/liveChat/messages/stream
      ?liveChatId=…&part=snippet,authorDetails&maxResults=2000[&pageToken=…]
```

This path is **not** in the v3 discovery document
(`https://www.googleapis.com/discovery/v1/apis/youtube/v3/rest` lists only
`delete`, `transition`, `insert`, `list` under `liveChatMessages`), and the
`streamList` reference page omits the "HTTP request" block every other method
page carries. It was established by probing unauthenticated, where the status
code distinguishes a real endpoint from a nonexistent one:

| path | status |
|---|---|
| `liveChat/messages` (known good) | 403 `PERMISSION_DENIED` |
| `liveChat/messages/stream` | **403 `PERMISSION_DENIED`** |
| `liveChat/messages/streamList` | 404 |
| `liveChat/messages/bogusnothing` (control) | 404 |

The reference page's error table listing both gRPC codes *and* "when using web
traffic to connect" HTTP codes confirms a REST transport is supported.

## The wire format

The response is **one top-level JSON array**, sent `Transfer-Encoding: chunked`,
whose elements arrive one at a time over the life of the broadcast:

```
[{ …LiveChatMessageListResponse… }
,{ …the next one, minutes later… }
]
```

`JSON.parse` is useless here — the array does not close until the broadcast
ends. `JsonArrayStreamParser` in `src/server/chatHub.ts` walks the bytes
tracking brace depth, string state and escapes, and yields each element the
moment it closes. The string handling is not decoration: a chat message
containing `{` or `"` would otherwise desynchronise the frame, and the failure
mode is "chat works for twenty minutes then stops", which is close to
undebuggable live. `scripts/test-chat.js` covers those cases.

Other things worth knowing:

- `nextPageToken` is the resume point. Keep it across reconnects or a dropped
  connection replays or skips the backlog.
- Reconnecting faster than the last `pollingIntervalMillis` earns
  `RESOURCE_EXHAUSTED`.
- `offlineAt` appears in the payload once the underlying stream goes down; a
  `liveChatEnded` / `liveChatDisabled` 403 means the same thing. Both route to
  `onChatEnded`, which is the only trigger for looking up a new broadcast.
- A 404 on the stream path means the endpoint is unavailable to this project;
  the code falls back to the old poller so chat still works, and logs loudly,
  because that path will exhaust the quota in an afternoon.

## If we need more headroom

Efficiency is the lever we control. Beyond that, the only supported route is the
**YouTube API Services audit and quota extension form**. It is a compliance
review rather than a merit one, takes weeks with no SLA, and grants steps (to
~100k) rather than blank cheques. Two things to get right in the application:
the subscription must not read as selling access to YouTube data, and the
privacy policy must name YouTube API Services and link Google's privacy policy.
