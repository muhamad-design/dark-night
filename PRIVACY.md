# Privacy Policy — Dark Night

**Last updated:** 2026-08-04

Dark Night is a Chrome extension that applies a dark theme to websites. This policy covers
what the extension does and does not do with your data.

## Data collection

Dark Night collects **no data**. It has:

- No server or backend of any kind
- No analytics or telemetry
- No account or sign-in
- No third-party network requests

Everything the extension does happens locally, inside your browser.

## Data storage

Dark Night stores your settings — the master on/off state, per-site exclusion list, and
appearance sliders (brightness, contrast, sepia, grayscale) — using Chrome's built-in
`chrome.storage` API. This data:

- Stays on your device (or syncs across your own signed-in Chrome browsers via Chrome Sync,
  a Google mechanism Dark Night does not control or have access to)
- Is never transmitted to Dark Night, its developer, or any third party
- Contains no browsing history, page content, or personal information — only your
  extension preferences and the list of site hostnames you've chosen to exclude

## Permissions

| Permission | Why it's needed |
|---|---|
| `storage` | Save your theme settings and per-site exclusion list |
| `scripting` | Inject the dark-theme styling into the page you're viewing |
| `host_permissions: <all_urls>` | Dark Night must be able to theme any site you visit, since you choose per-site whether it applies |

None of these permissions are used to read, collect, or transmit your browsing data anywhere.

## Open source

Dark Night's full source is public: every line that touches your browser — the theming
engine, the popup, the background worker — is available for review at
[github.com/muhamad-design/dark-night](https://github.com/muhamad-design/dark-night).

## Changes to this policy

If this policy changes, the update will be reflected here with a new "Last updated" date.

## Contact

For questions about this policy, open an issue at
[github.com/muhamad-design/dark-night/issues](https://github.com/muhamad-design/dark-night/issues).
