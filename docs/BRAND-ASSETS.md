# Brand assets

The product is **Apex AIO System**. The **Apex & Chill Racing League** is a
separate thing that still exists, still has its own logo, and still owns
`apexandchillracing.co.uk` — so the rule is:

> Anything that is the *app* wears the Apex AIO lockup. Anything that is the
> *league* keeps the league's own identity, including the league website's
> header and footer, and every sentence in the app that talks about racing with
> Apex & Chill.

---

## The masters

`electron/control-panel/assets/` holds the four files everything else derives
from. They come from the **Apex AIO — Apex Line logo pack**; all lettering is
outlined, so no font is needed anywhere.

| File | What it is | Used by |
|---|---|---|
| `apex-aio-lockup.svg` | horizontal, gradient symbol + white lettering | panel top bar, sign-in screen, pit wall, overlay corner mark, installer header |
| `apex-aio-lockup-dark.svg` | the same with black lettering | anything on a light ground (nothing yet — kept so the next light surface does not have to go hunting) |
| `apex-aio-icon.svg` | the symbol alone, **squared** to 525×525 | narrow strips, in-game edit toolbar, email masthead |
| `apex-aio-stacked.svg` | symbol above lettering | installer sidebar |
| `icon.png` | 256×256 | the Electron `BrowserWindow` icon |

The icon master is squared on purpose. The pack ships the symbol at 525×495,
and a 40×40 email badge or a Windows icon cut from that is stretched — so the
artwork is placed on a 525×525 canvas with 15px of extra room top and bottom
rather than resized into one.

`overlay/img/` and `promo/public/brand/` hold copies of the lockup and icon,
because the overlay is served by the app's own HTTP server and the promo film
by Remotion — neither can reach into the panel's asset folder.

## The generated things

Both outputs are committed, so an ordinary build needs neither script nor
`sharp`:

```
npm run icons           # build/icon.png, build/icon.ico, assets/icon.png
npm run installer:art   # build/installer{Sidebar,Header}.bmp, uninstallerSidebar.bmp
```

`npm run icons` reads `build/icon-master.png` — the pack's own 1024px square
export — rather than rasterising an SVG, because the pack's square export
already carries the optical padding a Windows icon wants.

`npm run installer:art` writes **BMP**, which is the only format NSIS takes for
those slots and which `sharp` can neither read nor write; the encoder is in
`scripts/make-installer-art.js` and checks its own output before writing.

The email masthead is generated separately, from `apex-aio-icon.svg`, by
`node scripts/email-assets.js` (see `web/src/email/manifest.json`).

## Two things that are not assets

- **The colour tokens.** `overlay/css/theme.css` and the panel's `--grad` were
  never changed to match the new pack. They did not need to be: the new palette
  (cyan `#00C8EF` → violet `#8B2CF5`) runs the same way as the old one, and
  repainting every widget is a different job from replacing a logo.
- **The partner stream overlay.** Its lockup is inlined into the served
  document in the *website* repo (`app/r/[code]/overlay/lockup.ts`), not
  referenced from here — that page has to arrive in one response because it is
  composited over live video.
