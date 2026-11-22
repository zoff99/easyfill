# EasyFill - One-Click Form Filler

> Almost 100% of this extension was written by AI. The code was produced by an AI
> assistant from plain-language instructions; a human set the requirements,
> tested the builds in a real Firefox browser and decided what shipped. Commits
> made that way are marked [AIassisted].
> 
> This is stated so you know it up front, not as a warning. Everything is here to
> read and audit: plain JavaScript with no build step, no minification and no
> dependencies; no internet access of any kind (zero network requests, and the
> manifest declares that no data is collected); nothing you type or save ever
> leaves your browser; and the repo ships unit tests over the shipped engine
> code, a source audit script (`tools/audit.sh`) that verifies no external
> CSS/JS/HTML/fonts are loaded and that no network APIs, endpoints or
> exfiltration paths exist, and a scan for hidden characters in the source (the
> codebase is plain ASCII).

**Save form answers once, fill every field in one click.** A small, fast, fully
local Firefox extension. Open source (MIT), no account, no limits, no network
calls - ever.

---

## Features

- **One-click form fill** - fill out a form once, click *Save this form*, and
  next time every field is filled in one click: text inputs, email/tel/url,
  number, date/time, textareas, dropdowns (single & multi), checkboxes, radio
  groups, and rich-text (`contenteditable`) editors like Gmail's compose box.
- **Unlimited values** - in Settings, add as many **short name -> value** pairs
  as you like. Right-click any form field, open **EasyFill**, and pick a value
  from the list - one menu level, no submenu. Reorder entries by dragging the
  grip or with the up/down buttons (keyboard friendly); the order is saved and
  matches the right-click menu. Mark any value as **sensitive**: inserting it
  then asks for confirmation in the page first, and neither the dialog nor
  the toast ever displays the value content - only its short name.
- **Right-click menu everywhere** - your values, *Fill form*, *Save this form*
  and *Settings*, directly in the browser's context menu.
- **Toolbar popup** - save the current form, see saved forms for the current
  site first, fill with one click.
- **Solid field matching** - fields are remembered by stable `name`/`id`
  selectors with an `nth-of-type` path fallback, plus label/placeholder
  *fingerprints* so fills survive small site changes. Machine-generated ids
  are ignored.
- **Framework-safe injection** - values are set through the native prototype
  setters and real `input`/`change` events, so React, Vue, Angular, and
  jQuery-era validators all notice the change.
- **Works in frames & shadow DOM** - captures and fills across iframes and
  open shadow roots.
- **Local-only & private** - everything lives in `browser.storage.local`.
  The extension makes **zero network requests** and declares
  `data_collection_permissions: { required: ["none"] }` - it collects
  and transmits no personal data at all. Password fields are excluded from
  saving unless you explicitly opt in. Feedback toasts show only a value's
  short name, never its content. (This manifest key requires
  Firefox 142 or newer, which is therefore the minimum supported version.)
- **Backup** - export/import everything as JSON.
- **Plain ASCII source** - no decorative unicode anywhere in the codebase.

## Install

### Temporary (development / quick try)
1. Open Firefox -> address bar -> `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on...**
3. Select `easyfill/manifest.json` (or the packaged `easyfill-1.0.0.xpi`).

Temporary add-ons stay until you restart Firefox.

### Permanent
Firefox requires signed add-ons for permanent install. Either:
- submit the zip to [addons.mozilla.org](https://addons.mozilla.org) as
  **unlisted** ("On your own") - you get a signed `.xpi` back in minutes, free; or
- use Firefox Developer Edition / Nightly / ESR with
  `xpinstall.signatures.required = false` in `about:config`.

> **Why Manifest V2?** Firefox fully supports MV2 (no deprecation planned),
> and MV2 grants host access at install time. Firefox MV3 makes host
> permissions opt-in *after* install, which would silently break "works on
> every site" until the user grants access.

## Use

1. **Save a form:** fill a form normally, then click the EasyFill toolbar
   button -> **Save this form** (or right-click -> EasyFill -> Save this form).
2. **Fill it:** next visit, right-click -> **EasyFill -> Fill form -> ...**, or
   use the popup's **Fill** button. A toast reports `filled N/M fields`.
3. **Per-field values:** Settings -> add *short name* + *value* pairs (no cap).
   Right-click any input -> **EasyFill** -> click the value you want. It is
   inserted into exactly the field you right-clicked.
4. **Edit saved answers:** Settings -> Saved forms -> "+ Fields" - rename
   forms, edit or remove individual saved answers.
5. **Reorder values:** Settings -> drag a row by its grip, or focus its up/down
   button and press Enter/Space repeatedly. Reordering is paused while the
   filter box is non-empty.

## How it works

| Piece | File | Role |
|---|---|---|
| Shared helpers | `src/shared.js` | storage keys, ids, URL matching, previews |
| Content script | `src/content.js` | field scan/capture, selectors + fingerprints, value injection, right-click target tracking, toasts |
| Background page | `src/background.js` | context menus, cross-frame capture/fill orchestration, first-run seed |
| Popup | `src/popup/*` | save / fill UI for the current tab |
| Settings | `src/options/*` | unlimited values editor, saved-form manager, options, backup |

**Capture** walks the page (including open shadow roots), skips
hidden/file/submit/disabled/invisible fields, groups radios by name+form, and
stores per field: `kind`, `value`, a stable CSS `selector`, a human `label`,
and a fingerprint (`name`, `id`, `label`, `placeholder`, `type`).

**Fill** resolves each selector in every frame/root; if the DOM changed, it
falls back to unique fingerprint matches. Values are applied with the native
`HTMLInputElement`/`HTMLTextAreaElement` prototype setters (bypassing
framework value trackers), `option.selected` for dropdowns, `.click()` plus
the native `checked` setter for checkboxes/radios, and
`execCommand("insertText")` for rich text - always followed by bubbling
`input` + `change` events.

**Cross-frame:** the background broadcasts to all frames, collects results for
a short window, then retries unresolved fields in a relaxed second pass.

**Context menu:** saved values are listed directly under the EasyFill root
(editable fields only), followed by Fill form, Save this form and Settings.

## Limitations (honest list)

- `input[type=file]` cannot be set by any web extension (browser security).
- Closed shadow roots and canvas-based editors are unreachable.
- Sites that require `isTrusted` events for every keystroke may ignore
  synthetic events (rare; most frameworks don't).
- Firefox blocks extensions on `addons.mozilla.org` and other privileged pages.
- Saved passwords (opt-in) are stored unencrypted in the browser profile.

## Development

```bash
node --check src/shared.js src/content.js src/background.js   # syntax
npm install linkedom                 # tiny DOM for tests
node tests/smoke.test.mjs            # 53 assertions over the real engine code
bash tools/audit.sh                  # safety audit: no external loads, no network, ASCII-only
```

Package: zip the extension root (manifest at zip root), excluding `tests/`
and `tools/`.

## License

MIT - see `LICENSE`. Copyright (c) 2026 EasyFill contributors.
