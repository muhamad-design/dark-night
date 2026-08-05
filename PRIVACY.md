# Privacy Policy — Dark Night

**Last updated:** 2026-08-05

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

Dark Night stores your settings — the master on/off state, the theming engine, the
appearance sliders (brightness, contrast, sepia, grayscale), the image setting, and the
per-site lists those choices produce: sites you've excluded, sites you've told it to theme
anyway, and sites you've given their own appearance settings — using Chrome's built-in
`chrome.storage` API.

It also keeps one thing you didn't choose: a local list of up to 200 site hostnames that
were measured as already rendering dark, so those pages don't flash the wrong colour on
your next visit. It is a rendering cache, kept on this device only (`chrome.storage.local`,
never synced), overwritten by the next measurement, and it records nothing about a page
beyond "this one looked dark". Turning off **Skip sites that are already dark** stops it
being written.

All of this data:

- Stays on your device — the settings above sync across your own signed-in Chrome browsers
  via Chrome Sync, a Google mechanism Dark Night does not control or have access to, and the
  already-dark list never leaves the machine that wrote it
- Is never transmitted to Dark Night, its developer, or any third party
- Contains no browsing history, page content, or personal information — only your extension
  preferences, the site hostnames those preferences apply to, and the already-dark list
  described above

## Permissions

| Permission | Why it's needed |
|---|---|
| `storage` | Save your theme settings, the per-site lists, and the already-dark cache |
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
