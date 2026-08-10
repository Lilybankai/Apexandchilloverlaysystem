"""Live probe: authenticate to raceos.gg the way the game does, then bulk-fetch
ranks for the drivers in the current session. Prints NO tokens."""
import json
import urllib.request

def get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.status, json.loads(r.read().decode())

def post(url, body, headers=None):
    h = {"Content-Type": "application/json"}
    h.update(headers or {})
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=h, method="POST")
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.status, json.loads(r.read().decode())

# 1. Steam session ticket from the game (local, same as the game's own UI).
st, tick = get("http://localhost:6397/rest/profile/getAuthSessionTicket")
ticket = tick.get("authSessionTicket", "")
print("ticket:", st, "len", len(ticket))

# 2. Authenticate to raceos.gg.
st, auth = post("https://raceos.gg/authenticate",
                {"token": ticket, "game": "lmu", "platform": "steam"})
tok = auth.get("accessToken", "")
me = auth.get("player") or {}
print("auth:", st, "token" if tok else "NO TOKEN", "banned:", auth.get("banned"))
print("me:", me.get("name"), "| DR:", json.dumps(me.get("driverRank")), "| SR:", json.dumps(me.get("safetyRank")))

# 3. Names from the current session's standings.
st, rows = get("http://localhost:6397/rest/watch/standings")
names = sorted({(r.get("driverName") or "").split("#")[0].strip() for r in rows if r.get("driverName")})
print("session drivers:", len(names))

# 4. Bulk rank lookup, the lobby's own call.
hdr = {"Game-Authorization": f"Bearer {tok}"}
st, players = post("https://raceos.gg/api/v1/players", {"usernames": names}, hdr)
print("players:", st, "returned", len(players) if isinstance(players, list) else type(players).__name__)
if isinstance(players, list):
    for p in players:
        dr = p.get("driverRank") or {}
        sr = p.get("safetyRank") or {}
        print(f"  {p.get('name')!r:28} DR {dr.get('rank')}{dr.get('tier')} elo={dr.get('elo')}  "
              f"SR {sr.get('rank')}{sr.get('tier')} rating={sr.get('rating')}")
