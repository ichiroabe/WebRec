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
- **▶ Replay** opens a new window and reproduces the recorded steps, showing progress step by step.

## Installing (unpacked, for development)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this `WebRec` folder

## Usage

1. Open the page you want to record, click the extension icon, and press **● Start recording**
2. Use the page as you normally would (click, type, navigate…)
3. Press **■ Stop and save** in the popup, or **■ Stop** on the on-page indicator
4. Open the manager to view, export or replay what you recorded

## What gets recorded

- Clicks (buttons, links, checkboxes, radio buttons, labels…)
- Text inputs and textareas — only the committed value is recorded (on `change`), so corrections and retyping never show up
- Select boxes, single and multiple
- Enter / Escape keys
- HTML5 drag and drop (moving items between two lists, etc.)
- File uploads (`<input type="file">` — see below)
- Operations inside iframes (the frame path is recorded and honoured on replay and in exports)
- Page transitions (SPA history changes are debounced into a single step)

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
| Data rows with different columns | row 1 has `b`, row 2 does not |
| No steps / every step disabled | — |
| Empty multi-select values | `"values": []` |

**Notes**

- Data columns no step refers to
- `optional` on a disabled step (it has no effect)

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

## Where the data lives

Recordings are stored in IndexedDB (`webrec-db`) in your browser profile. Nothing is ever sent to an external server.

## Known limitations

- Recording is limited to one tab (switching tabs after starting does not record the other tab).
- Cross-origin iframes cannot be located, so recording and replay there are incomplete.
- Drag and drop is supported only where the page uses HTML5 drag events (not mousedown/mousemove implementations).
- Password fields (`type="password"`) are masked as `<PASSWORD>`; the real value is never stored.
- Selectors are generated in the order `data-testid` / `id` / `name` / `aria-label` / CSS path, so pages with highly dynamic DOM structures may replay less reliably.
- The built-in replay is deliberately simple. For complex SPAs, exporting the Playwright / Puppeteer script and running it under Node.js is recommended.
