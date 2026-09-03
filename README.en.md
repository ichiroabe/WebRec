# WebRec

[日本語](README.md) | English

A Chrome extension (Manifest V3) that records what you do in the browser and turns it into a reproducible script — replayable in the browser itself, or exported as Playwright, Puppeteer or JSON.

## Language

Japanese and English are both supported. Switch with the selector in the manager header or at the top right of the popup. The first time, the language is picked from your browser; after that your choice is remembered.

## Features

- Click **Start recording** in the extension popup. The page you are on becomes the **start URL**.
- Clicks, text input, select boxes, Enter/Escape, drag and drop, file uploads and page transitions (including SPA history changes) are all captured automatically.
- While recording, an indicator appears at the top right of the page; you can stop from there too.
- **Stop and save** stores the recording in the browser's IndexedDB.
- The manager (popup → *Open script manager*, or the extension's *Options*) lists your recordings and lets you rename, delete, import and export them.
- Every recording can be exported as:
  - **Playwright** (`@playwright/test` style)
  - **Puppeteer**
  - **JSON** (the raw steps)
  - Copy to clipboard or download as a file.
- **▶ Replay** reproduces the recorded steps, showing progress step by step. It can run in a new window or in an **existing tab you already prepared** (logged in, on the right screen).
- Every replay is kept in the **run log** — which step failed, and any dialog that appeared.
- **⏰ Schedules** run a recording daily at a time, or every N minutes (while the browser is open).
- **Assertion steps** (`assertText` / `assertVisible` / `assertMissing`) stop the run when the page is not what you expected.
- Sites behind **basic auth** (staging environments, …) replay without the login dialog once you register the credentials.

## Installing (unpacked, for development)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this `WebRec` folder

## Usage

1. Open the page you want to record, click the extension icon, and press **● Start recording**
2. Use the page as you normally would (click, type, navigate…)
3. Press **■ Stop and save** in the popup, or **■ Stop** on the on-page indicator
4. Open the manager to view, export or replay what you recorded

## Automatic tidy-up after recording

When you stop recording, **consecutive repeats of the same action are collapsed into the last one**. This happens after the fact rather than during recording, so the raw sequence can be reprocessed with different rules.

| Collapsed | Example |
| --- | --- |
| Consecutive inputs on one field | typed, left, came back and typed again → only the final value |
| Consecutive scrolls | scrolled in bursts → only the final position |
| Consecutive selections on one select | → only the final choice |
| Consecutive edits of one rich-text area | → only the final content |

Some things are never collapsed:

- **Clicks, key presses, navigations and uploads** — each one means something on its own
- **Anything with a step in between** — "type → search → type again" keeps both
- **The same selector in a different frame** — treated as a different element
- **Steps carrying `disabled` / `optional` / `waitBeforeMs` / `timeoutMs`** — your edits are not thrown away

The **Tidy up** button in the Steps list runs it again at any time — useful after importing a recording or editing the JSON by hand. Running it repeatedly changes nothing.

### One caveat

In a tag/chip input, where leaving the field *adds* an entry, consecutive inputs each mean something different. Collapsing them would lose the earlier entries. Check the Steps list after recording such a page (in practice a click or key press usually falls between them, so they are not collapsed).

## Supported input patterns

| Category | Supported |
| --- | --- |
| Text inputs (text / email / tel / url / search / number / password) | Yes — committed value only; passwords are masked |
| Date inputs (date / time / datetime-local / month / week) | Yes |
| range (slider), color | Yes |
| textarea | Yes |
| Checkboxes and radio buttons | Yes |
| select (single and multiple) | Yes |
| **contenteditable / rich text editors** | Yes — the content is captured when focus leaves |
| **Shadow DOM (Web Components)** | Yes — recorded and replayed as `host >>> inner` |
| div-based custom dropdowns | Yes — recorded as a sequence of clicks |
| HTML5 drag and drop | Yes |
| **Mouse-driven drags and canvas drawing** | Yes — recorded as a path of coordinates |
| **Double-click and right-click** | Yes |
| Key presses | Yes — Enter / Escape / Tab / arrows / F-keys / combinations with Ctrl, Alt, ⌘ |
| **Scroll position** | Yes — both window and element |
| File uploads | Yes — contents included |
| Operations inside iframes | Yes |
| **Operations inside frameset `<frame>`s** | Yes — located by name or position |
| **Links that open a new tab (`target="_blank"`)** | Yes — recording and replay both follow the new tab |
| **alert / confirm / prompt** | Yes — the answer you gave is recorded, and replay returns it without showing a dialog (see below) |
| **The basic auth dialog** | Yes — register the credentials and they are sent as a header, so the dialog never appears ([Basic auth](#basic-auth-the-browsers-login-dialog)) |
| Page transitions (including SPA history changes) | Yes |

### Notes

- **Key presses**: ordinary typing is not recorded (the committed value is captured separately). Only special keys and modifier combinations are.
- **Mouse paths**: only movements of 8px or more are recorded as a path, which keeps them distinct from plain clicks. Up to 300 points per gesture.
- **alert / confirm / prompt**: the OK and Cancel buttons belong to the browser, not the page, so an ordinary event listener never sees them. While recording, `window.confirm` and friends are replaced so that **the real dialog still appears** and only the answer you gave is kept, as a step reading `Dialog: confirm "Delete for real?" -> Cancel`. During replay **no dialog is shown**: the recorded answer is returned on the spot. A dialog that was never recorded still falls back to the old behaviour — `confirm` returns OK, `prompt` returns its default. Exported scripts register `page.once('dialog', ...)` just before the action that opens the dialog.
- **Answers to prompt**: these accept `{{data.column}}` and the other templates, like any other input value. Edit `answer` on the JSON (editable) tab of the detail dialog (`null` means Cancel was pressed).
- **Shadow DOM**: open shadow roots only (`mode: 'closed'` is unreachable from outside by design). Exports use Playwright's automatic piercing, or Puppeteer's `>>>` syntax.

### Not supported

- Shadow DOM with `mode: 'closed'`
- Hover-only menus (clicks are recorded once the item is clickable, but the hover itself is not)
- The copy/paste gesture itself (the resulting value is recorded)
- The browser's back/forward buttons
- **Auth dialogs other than basic auth** — digest auth, NTLM / Kerberos (integrated Windows auth), client certificate selection, and proxy authentication. The dialog looks the same, but adding an `Authorization: Basic ...` header does not satisfy them

## JSON is the script

The recording *is* the JSON. Playwright and Puppeteer output are generated from it.

Open the detail dialog → **JSON (editable)** to edit it directly and press **Save**. It is validated first, and problems are reported precisely (`steps[3].selector is missing`), so a broken script can never be saved.

**Click any row in the Steps list** to jump to that step in the JSON, selected and scrolled into view. The first row jumps to `startUrl`.

- **Rename**: click the name in the list (Enter to confirm, Esc to cancel). Empty names are rejected and surrounding whitespace is trimmed.
- **Export**: *Download* for one recording, *Export all* in the header for everything in one file.
- **Import**: *Import* in the header. Single recordings, the export-all format, and plain arrays are all accepted. Imported recordings always get a new id, so nothing is overwritten.

### Validation

The **Validate** button (and opening the JSON tab, saving, or importing) checks not just that the JSON parses, but that the scenario makes sense. Click an issue to jump to the step.

**Errors** (these block saving)

| Problem | Example |
| --- | --- |
| Reference to a column the data does not have | `{{data.name}}` when the column is `fullName` |
| `{{data.x}}` with no data at all | the Data tab is empty |
| Not a valid selector | `###` |
| `timeoutMs` / `waitBeforeMs` / `ms` not a number, or negative | `"timeoutMs": "abc"` |
| `navigate` URL is not http/https | `ftp://…` |

**Warnings** (saving is allowed)

| Problem | Example |
| --- | --- |
| Unknown variable | `{{today}}` — it will be typed literally |
| Password never filled in | the value is still `<PASSWORD>` |
| Basic auth username or password is empty | added on the "Basic auth" tab but left blank |
| Data rows with different columns | row 1 has `b`, row 2 does not |
| No steps / every step disabled | — |
| Empty multi-select values | `"values": []` |

**Notes**

- Data columns no step refers to
- `optional` on a disabled step (it has no effect)
- Basic auth credentials are stored in the recording (they are included in exports)

Errors name the real alternatives (`available: fullName, age`), so a typo can be fixed on the spot.

## File uploads

`<input type="file">` is supported. The OS file dialog cannot be automated, but it does not need to be: **the contents of the file you pick are stored at record time and injected straight into the input on replay**. No dialog opens.

- Recording: just pick the file as usual. Both the name and the **contents** are stored (up to 8MB per step).
- Replay: a `File` is rebuilt from the stored contents, assigned to `input.files`, and `input` / `change` are fired. The page cannot tell the difference.
- `multiple` inputs and clearing the selection are supported.

**Things to know**

- File contents live in IndexedDB and are **embedded in JSON exports**. Be careful where you send exports of confidential files.
- Files over 8MB are not stored, and validation reports this as an error.
- Drag-and-drop uploads are not supported (`<input type="file">` only).

**In exported scripts**

Playwright and Puppeteer take a local file path, so the output is `setInputFiles('./files/invoice.pdf')` and the required file names are listed in a comment at the top. Get the real files from **⭳ Save …** in the Steps list and put them in `files/`.

## Variables in values (today's date, etc.)

Write `{{...}}` in `value` or `url` and it is **replaced with a run-time value on every replay**, so a recording is not frozen to the day it was made.

| Syntax | Result (run at 2026-08-27 14:05) |
| --- | --- |
| `{{date}}` | `2026-08-27` |
| `{{date:MM/DD/YYYY}}` | `08/27/2026` |
| `{{date:YYYY}}` / `{{date:MM}}` / `{{date:DD}}` | `2026` / `08` / `27` (for forms with separate fields) |
| `{{date:M}}` / `{{date:D}}` | `8` / `27` (no zero padding) |
| `{{date:YYYY-MM-DD\|+1d}}` | `2026-08-28` (`+1d` `-3d` `+2w` `+1m` `-1y`) |
| `{{time:HH:mm}}` | `14:05` |
| `{{datetime}}` | `2026-08-27 14:05:09` |
| `{{random:0000}}` | `0473` (4 digits, zero-padded; `####` for none) |
| `{{random:1-100}}` | `57` |
| `{{seq}}` | `42` (a counter, +1 per replay, no padding) |
| `{{seq:000}}` | `042` (the same counter, zero-padded) |
| `{{uuid}}` | a random UUID |

The format goes after `:`, further options after `|` (so a `:` inside a format, as in `{{time:HH:mm}}`, is fine).

**Number formats** (`{{seq}}`, `{{row}}` and `{{random}}` all follow this)

| Syntax | Result | Use |
| --- | --- | --- |
| `{{seq}}` | `42` | plain counter |
| `{{seq:#}}` / `{{seq:####}}` | `42` | same — `#` does not force a width |
| `{{seq:000}}` | `042` | pad to 3 digits |
| `{{seq:00000}}` | `00042` | pad to 5 digits |

The number of `0`s is the width. Values wider than the mask are never truncated (`{{seq:00}}` with 12345 gives `12345`).

- The date and `{{seq}}` are fixed for the whole replay, so a date never changes halfway through a scenario.
- Unknown variables are left as-is, so nothing is silently replaced by mistake.
- The Steps list shows the resolved value (`→ currently "2026-08-27"`).
- **Exported Playwright / Puppeteer scripts behave identically** — the same resolver is embedded and values are resolved at run time. Recordings that use no variables get no extra code.

You can see and change the current `{{seq}}` in **⚙ Settings**; set it to 1 to start over.

## Running with different data (data-driven)

To run one scenario many times with different inputs, add a table in the **Data (loop)** tab. The scenario runs **once per row**.

### 1. Add the data

**Paste CSV/TSV** accepts a table copied straight out of Excel (first line = column names). You can also write JSON directly.

```json
[
  { "name": "Alice", "age": "30", "plan": "pro" },
  { "name": "Bob",   "age": "25", "plan": "free" },
  { "name": "Carol", "age": "41", "plan": "max" }
]
```

### 2. Refer to columns from steps

```json
{ "type": "input",  "selector": "#name", "value": "{{data.name}}" }
{ "type": "input",  "selector": "#age",  "value": "{{data.age}}" }
{ "type": "select", "selector": "#plan", "value": "{{data.plan}}" }
{ "type": "input",  "selector": "#ref",  "value": "REF-{{date:YYYYMMDD}}-{{row:000}}" }
```

| Syntax | Meaning |
| --- | --- |
| `{{data.column}}` | that column in the current row (`{{data:column}}` also works) |
| `{{row}}` / `{{row:000}}` | which row this is (1-based, zero-padding optional) |

- Column names are **case sensitive**.
- A reference to a column that does not exist is typed as `{{data.xxx}}` verbatim, so mistakes are obvious. The Data tab also marks missing cells in red.
- Each row **returns to the start URL first**, so nothing carries over from the previous row.
- The date and `{{seq}}` are fixed for the whole run; only `{{row}}` changes per row. Combine them (`{{seq}}-{{row}}`) for values unique across both.
- Replay progress is grouped per row (`Row 1/3: name=Alice …`).
- Exported scripts loop too — Playwright emits one test per row, Puppeteer a `for` loop.

## Waits (slow servers, reloads)

- **Reloading while recording**: recording continues across reloads (the content script asks for the session state on load). A reload of the same URL is not itself recorded as a step.
- **Honouring natural navigation**: if a click already took you to the target URL, a `navigate` step does not navigate again — so a POST result page is not clobbered.
- If a wait times out, only that step is marked failed; the rest keep running.

Settings resolve in three layers, the lower ones winning.

### 1. Global (⚙ Settings in the manager)

| Setting | Default | Purpose |
| --- | --- | --- |
| Page load timeout | 60000ms | raise it for slow servers |
| Element wait timeout | 8000ms | raise it for slow-rendering screens |
| Delay between steps | 350ms | raise it for animation-heavy screens |
| Retries on failure | 3 | retries when a step collides with a page transition |

### 2. Per recording

The **Settings for this recording** tab lets you choose, field by field, between *Use global setting* and a value just for this recording.

- Only the fields you uncheck are stored; the rest keep following the global settings.
- Fields still following the global settings pick up later changes to them automatically.
- Recordings with overrides show as `Settings for this recording ●2`.
- **Reset all to global** clears them.

The same thing written directly in the JSON:

```json
{
  "startUrl": "https://example.com/",
  "settings": { "pageLoadTimeoutMs": 180000 },
  "steps": []
}
```

### 3. Per step (when only one screen is slow)

**The quickest way to add a wait** is the **＋ Wait** button that appears when you hover a row in the Steps list. Enter the number of seconds and a wait step is inserted **before** that row.

Hovering a row also reveals these:

| Button | What it does |
| --- | --- |
| **＋ Wait** | insert a wait before this row |
| **＋ Assert** | insert an assertion after this row |
| **⃠ Disable / ↺ Enable** | skip this step without removing it, or bring it back |
| **✕ Delete** | remove this step (asks first; cannot be undone) |

Disabling first is the safer move: you can see the effect before deleting. Disabled rows are shown struck through.

Add these to any step in the JSON.

| Key | Meaning |
| --- | --- |
| `"timeoutMs": 120000` | wait longer for this element only |
| `"waitBeforeMs": 3000` | pause before running this step |
| `"optional": true` | continue (as a warning) if it fails |
| `"disabled": true` | skip this step without deleting it |

There are also dedicated waiting steps:

```json
{ "type": "wait", "ms": 5000 }
{ "type": "waitForSelector", "selector": "#result-table", "timeoutMs": 300000 }
```

For a long batch job, waiting for the element that appears on completion (`waitForSelector`) is steadier than a fixed delay. Both appear in the exported Playwright / Puppeteer scripts.

## One-time passwords (2FA)

**A recorded code cannot be replayed.** TOTP codes rotate every 30 seconds, so the number captured at record time is already invalid by the time you replay. Codes delivered by SMS or email cannot be reproduced either.

WebRec handles this as follows.

1. **While recording**: one-time-code fields are detected and the value is masked as `<OTP>` — the real code is never stored. Detection looks at `autocomplete="one-time-code"` first, then falls back to words like `otp`, `totp`, `mfa`, `2fa` in the name/id/placeholder/aria-label.
2. **Validation**: a leftover `<OTP>` is reported as an error, with the fix.
3. **On replay**: write `{{totp:SECRET}}` and the **correct code is computed on the spot**.

```json
{ "type": "input", "selector": "#otp", "value": "{{totp:JBSWY3DPEHPK3PXP}}" }
```

The secret is the Base32 string shown when you enrol an authenticator app (printed next to the QR code, or the `secret=` parameter of the `otpauth://` URL). Lowercase, spaces and dashes are fine. For systems that use 8 digits, write `{{totp:SECRET|8}}`.

**Exported Playwright / Puppeteer scripts do the same** — an implementation using Node's `crypto` is embedded and the code is computed on every run (RFC 6238, verified against the official test vectors).

### Things to know

- The secret is **a credential as sensitive as a password** — anyone holding it can generate codes. It is stored in the recording and embedded in JSON exports, so use it **for test accounts only** and be careful where exports go.
- Do not embed a production account's secret.
- If an authenticator extension (1Password, Authenticator, …) autofills the code, the number is still not stored — it is recorded as `<OTP>`. Replace it with `{{totp:...}}` the same way.
- SMS, email and push-based verification cannot be reproduced by nature. Disable 2FA in your test environment, or use a fixed test code.

## Basic auth (the browser's login dialog)

The **username/password dialog** that pops up the moment you open a staging site is supported.

Like `alert` / `confirm`, that dialog belongs to **the browser**, not the page — and unlike them there is not even a `window.*` function to replace. It cannot be driven from page JavaScript, so WebRec does not try to answer it: it makes sure it **never appears**. While replaying, a rule adds an `Authorization: Basic ...` header, so the server responds as already authenticated.

### Setting it up

Open a recording, go to the "**Basic auth**" tab, and add the target URL, username and password. The first row you add is pre-filled with the origin of the start URL.

The target URL is matched as a **prefix**.

| Written as | Covers |
| --- | --- |
| `https://staging.example.com/` | the whole site (typical for a staging environment) |
| `https://staging.example.com/admin/` | only that subtree (page and sub-resources alike) |
| `http://192.168.0.10:8080/` | a different port is a different target |

- A missing trailing `/` is filled in (`https://example.com` becomes `https://example.com/`). Writing `/*` is fine too — the `*` is dropped, since matching is by prefix.
- Add a row per protected host, up to 20.
- Pasting `https://user:pass@example.com/` into the URL field moves the credentials into the username/password fields. That is deliberate: **credentials do not belong in a URL** (they leak into referrers and history).
- Username and password accept variables such as `{{data.column}}`, so a data-driven run can **use a different account per row**.

The JSON tab does the same thing:

```json
{
  "startUrl": "https://staging.example.com/",
  "basicAuth": [
    { "url": "https://staging.example.com/", "username": "qa", "password": "s3cret" }
  ],
  "steps": []
}
```

### What happens during replay

- The rules are registered as **`declarativeNetRequest` session rules**. They never touch disk, and they are removed when the replay ends — including when it fails.
- They apply **only to the tab being replayed**, so your normal browsing is unaffected. The one exception is a recording containing a `newTab` step: the first request of a freshly opened tab would arrive before the rule could be narrowed to it, so for those the rules apply browser-wide for the duration of the replay.
- The rules are installed **before** the start URL is loaded (a new window opens on `about:blank` first, then navigates).
- If a previous replay died and left rules behind, they are cleaned up when the extension starts and again when a replay begins.

### In exported scripts

The same credentials come out as each framework's dedicated API.

| Output | Generated code |
| --- | --- |
| Playwright | `test.use({ httpCredentials: { username, password, origin } })` |
| Puppeteer | `await page.authenticate({ username, password })` |

- Both answer a 401 challenge rather than sending the header up front, so path scoping is left to the server (the path part of the target URL has no effect in exports).
- Both APIs hold **one set of credentials**. With more than one entry, the first is exported and the rest are listed in a comment at the top.
- In Playwright output for a data-driven recording, variables in the credentials are not resolved — replace them with real values. Puppeteer resolves them in both cases.

### Things to know

- The username and password are **as sensitive as any password**, like a TOTP secret. They are stored in plain text in the recording (IndexedDB) and are included **both in JSON exports and in generated scripts**. Use **test accounts only** and be careful where they go.
- Validation always reports that a recording carries credentials, and also flags an empty password, a leftover `<PASSWORD>`, or a malformed target URL.
- **Nothing is detected automatically while recording.** Watching for 401 challenges would require the `webRequest` permission, widening what the extension can do. After recording a site that shows the dialog, add the entry here by hand.
- **Watch out for "it works by hand but stalls on replay".** Once you type the credentials, the browser remembers them for the profile — that is the "HTTP auth" row in [Login sessions during replay](#login-sessions-during-replay). So an unregistered site may replay fine today, yet stop working after a browser restart, and never work in an exported script (a different profile). **Register them here to replay reliably.**
- After updating to a version that includes this feature, **reload the extension** at `chrome://extensions`. Until the new permission (`declarativeNetRequestWithHostAccess`) takes effect, registered credentials cannot be applied.

## Login sessions during replay

Where replay starts is chosen in the dialog that appears after you press "▶ Replay".

| Target | Behaviour |
| --- | --- |
| **New window** (default) | Opened with `chrome.windows.create`, starting from the start URL |
| **A tab you pick** | Replays in that tab. With "start from the page currently shown" it does not navigate to the start URL and continues from what is on screen |

Pick a tab when you want to log in or set things up by hand first. The popup's "▶ Replay in this tab" opens the manager with that tab preselected. "Start at step" lets you skip the steps you already did yourself (login, etc.).

A new window is a normal (non-incognito) window in the **same profile**, so most things carry over.

| Item | Carried over? |
| --- | --- |
| Cookies | Yes |
| localStorage | Yes |
| IndexedDB / HTTP auth | Yes |
| **sessionStorage** | **No** — it is isolated per tab |

With cookie-based login, a recording that starts from a logged-in screen replays as-is.

If the site keeps its auth token in `sessionStorage`, however, a new window counts as logged out. In that case **include the login steps in the recording**, or log in by hand and pick that tab as the replay target (`sessionStorage` is per tab, so replaying in the same tab keeps it). You will need that anyway to run the exported script in CI. Passwords are masked as `<PASSWORD>` when recorded, so either replace the value on the JSON tab, or use `{{data.password}}` and manage it from the Data tab.

## Run log

"📋 Run log" in the manager keeps one record per replay. Click a row to expand the per-step results.

| Recorded | Details |
| --- | --- |
| Start / end time, duration | When it ran and how long it took |
| Trigger | manual or scheduled |
| Per-step result | succeeded / failed / skipped / optional-warning, with the error text |
| Fallback selector used | The candidate that matched when the primary selector missed |
| Dialogs | Any `alert` / `confirm` / `prompt` raised during the run, the answer returned, and whether it came from the recording |

The newest 100 runs are kept; older ones are dropped automatically. "Delete all" clears them by hand.

The log is written as the run proceeds, so **closing the manager tab does not lose what happened so far** (you only lose the live progress view).

## Schedules

"⏰ Schedules" in the manager runs a recording automatically.

- **Every day at** — e.g. 07:30 every day
- **Every N minutes** — e.g. every 15 minutes

Each row can be enabled/disabled or deleted, and shows the last run time and result. The details are in the run log.

Limits:

- It runs **only while the browser is open** (nothing happens while the machine sleeps; a run may fire late after waking).
- A scheduled run always opens **a new window at the start URL** — it cannot use a tab you prepared by hand, so **include the login steps in the recording**.
- Only one replay runs at a time; starting another while one is running is an error.

## Assertion steps (stop when the page is wrong)

For irreversible actions such as deleting or sending, it is safer to confirm the screen first. Add one with the "**+ Assert**" button on each row of the step list, or on the JSON tab.

```json
{ "type": "assertText", "selector": "#msg", "value": "deleted" }
{ "type": "assertText", "selector": "#title", "value": "Inbox", "match": "equals" }
{ "type": "assertVisible", "selector": "#result" }
{ "type": "assertMissing", "selector": "#row-3" }
```

- `assertText` — the element's visible text **contains** the expected text (`"match": "equals"` for an exact match)
- `assertVisible` — the element is actually visible (rejects `display:none` and friends)
- `assertMissing` — the element is **gone** (to confirm a row disappeared after deleting)

A mismatch fails that step and the run log keeps `Expected "…", got "…"`. Add `"optional": true` to downgrade it to a warning and continue.

## Fallback selectors (one miss does not stop the run)

Recording stores **several ways to point at the same element**, in priority order. Replay tries them from the top, so a small page change is less likely to stop everything.

```json
{
  "type": "click",
  "selector": "a[href=\"right_main.php?mailbox=INBOX\"]",
  "selectors": [
    "a[href=\"right_main.php?mailbox=INBOX\"]",
    "div#box > table > tbody > tr:nth-of-type(1) > td > a",
    "a:text(\"Inbox\")"
  ]
}
```

The order is `data-testid` → `id` → `name` → `aria-label` → `href` / `value` → CSS path (position) → visible text. `tag:text("label")` is a WebRec-only notation, not CSS, and is used **only when exactly one element matches** (to avoid acting on the wrong one) and only on the last retry.

When something other than the first candidate matched, the progress view and the run log say so. **That message means the primary selector is already dead** — fix it on the JSON tab rather than leaving it.

`selector` (the single, original field) is written alongside, so older recordings and the script exports keep working.

## Tests

```bash
npm install
npm test
```

26 suites run, each in its own process. Pass part of a name to narrow it down.

```bash
npm test -- totp
```

The extension itself cannot run under Node, so the tests cover the **parts that do not depend on a browser**.

| Area | What is covered |
| --- | --- |
| Storage | IndexedDB reads and writes, run-log pruning, database upgrades |
| Script generation | Playwright / Puppeteer / JSON output, including that the generated code parses |
| JSON validation | Malformed input is rejected with a specific reason; valid recordings produce no false positives |
| Template variables | Date formats and offsets, zero padding, TOTP (checked against the official RFC 6238 vectors) |
| UI wiring | Every id manager.js references exists in manager.html; only one panel is visible at a time |
| Languages | The Japanese and English catalogs match; every key used in code is defined |
| Basic auth | Target URL normalization, the header value (RFC 7617), the rules that get installed, and that they are removed afterwards |

jsdom stands in for the DOM, and fake-indexeddb for IndexedDB.

### Pages for manual testing

Sample pages are included so you can try recording and replaying for real.

```bash
npm run serve
```

- http://127.0.0.1:8791/complex.html — an ordinary form (text, selects, dual list, drag and drop, uploads, iframe)
- http://127.0.0.1:8791/patterns.html — the awkward cases (contenteditable, Shadow DOM, custom dropdown, right-click, canvas, dialogs, new tab)

Sample files for upload testing live in `test/fixtures/samples/`.

## Under consideration

A design note on connecting web and local work is in [docs/automation-plan.md](docs/automation-plan.md) (Japanese).

## Where the data lives

Recordings (including basic auth credentials), uploaded file contents and the run log all live in IndexedDB (`webrec-db`) in your browser profile; schedules and the language setting live in `chrome.storage.local`. Nothing is ever sent to an external server.

They disappear with the profile, so **export the JSON regularly with "Export all"** — with that file you can restore everything through "Import" on a fresh machine.

## Known limitations

- Recording is primarily one tab, though a new tab opened by the page (`target="_blank"`) is followed automatically. Tabs you switch to yourself are not.
- Cross-origin iframes cannot be located, so recording and replay there are incomplete.
- Only one replay runs at a time (two would fight over the same tab).
- Scheduled runs only fire while the browser is open; this is not a fit for always-on automation.
- Password fields (`type="password"`) are masked as `<PASSWORD>`; the real value is never stored.
- [Basic auth](#basic-auth-the-browsers-login-dialog) credentials, by contrast, **are stored in plain text** — they have to be sent — and are included in JSON exports and generated scripts. Use test accounts only.
- Basic auth rules apply browser-wide for the duration of a replay when the recording contains a `newTab` step; otherwise they are limited to the tab being replayed.
- Selectors are generated in the order `data-testid` / `id` / `name` / `aria-label` / CSS path, so pages with highly dynamic DOM structures may replay less reliably.
- The built-in replay is deliberately simple. For complex SPAs, exporting the Playwright / Puppeteer script and running it under Node.js is recommended.
