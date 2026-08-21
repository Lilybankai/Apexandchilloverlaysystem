# VR overlay test — Quest 2 (Phase 0 tester instructions)

Send this to the VR tester as-is. Context for us: this is Phase 0 of
`docs/VR-OVERLAY-PLAN.md` — proving the SteamVR-overlay concept over online LMU
(EAC active) with zero code, using Desktop+. Time: 30–60 minutes.

---

**What this is:** Before we build VR support into the Apex AIO app, we want
to prove the idea works on your setup using a free tool. You'll pin the
existing overlays into your headset while racing online, then tell us what you
saw. No special skills needed.

**You'll need:**

- Your Quest 2 with a Link cable (cable is best for this test — Air Link is OK
  if you don't have one)
- Le Mans Ultimate on Steam, and the Apex AIO app you already use
- One free install: **Desktop+** — search for it on Steam (it's free) and
  install it

## Setup — this bit really matters

1. Put on the headset, connect **Quest Link** to your PC as normal.
2. Start **SteamVR** on the PC (or launch any Steam VR game once so it starts).
3. Launch **Le Mans Ultimate from Steam**. When Steam shows the launch picker,
   choose the **SteamVR** option.

> ⚠️ **Don't** launch LMU with a `+VR` shortcut, and don't use Virtual
> Desktop's own VR mode for this test. Our overlays can only ever appear when
> the game goes through **SteamVR** — that's the whole thing being tested. If
> you normally use Virtual Desktop, please use the Link cable instead just for
> this session.

4. Start the **Apex AIO app** and turn on the in-game overlays like you
   normally would (they'll appear on your desktop monitor — that's fine,
   that's where we grab them from).

## Pinning the overlays into the headset

5. In VR, press the **menu button** on your left controller to open the
   SteamVR dashboard, and open **Desktop+**.
6. Desktop+ shows your desktop inside VR. Use its **crop/region** option to
   select just the part of the screen where an Apex widget sits (start with
   the **relative** widget), and pin it as a floating panel.
7. Grab the panel and place it where a dashboard display would be — slightly
   below your eyeline, comfortable to glance at. Make it big enough to read
   without leaning in.

## The test

8. Join an **online session** (this matters — we need anti-cheat running) and
   drive at least 10–15 laps like a normal stint.
9. Partway through, use Desktop+ to **hide the panel**, drive a couple of
   laps, then show it again — we want to know if you can feel any difference.

## What to tell us afterwards

Just answer these — a voice note or a few lines is perfect:

1. Did LMU start and run **online** normally, no anti-cheat complaints?
2. Could you **see the panel** clearly in the headset while driving?
3. **Reading test:** could you actually read the gap times on the relative?
   What about smaller text — is anything blurry or smeary no matter how you
   position it?
4. **Performance:** did the game feel any different with the panel shown vs
   hidden? Any stutter, lag, or dropped frames? (If you know SteamVR's
   frame-timing graph, a before/after glance is gold — but "felt fine / felt
   worse" is genuinely useful.)
5. **Comfort:** did a fixed floating panel feel OK while turning your head, or
   annoying/nauseating?
6. Anything weird — flicker, the panel vanishing, SteamVR acting up.

If it renders, reads OK, and costs nothing noticeable — we build the real
thing, which will look far better than this taped-together version. Thanks! 🏁
