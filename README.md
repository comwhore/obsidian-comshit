# comshit

**comshit** is an Obsidian desktop plugin that extends Canvas mind mapping, keeps `.md` and `.canvas` files paired, runs OSINT CLIs (Sherlock, Maigret, Social Analyzer) on node text, and embeds spreadsheet support for `.sheet` files in one plugin folder.

## Features

- Lovely-Mindmap-style Canvas keyboard shortcuts (`Tab`, `Enter`, `Shift + Enter`, `Mod + Esc`, directional navigation).
- Paired Markdown and Canvas sync (bidirectional, debounced).
- Commands to create, convert, and open graph pairs.
- Sherlock, Maigret, and Social Analyzer integration (external CLIs; not bundled).
- Embedded Excel-modded runtime for `.sheet` files (disable the separate community **Excel** plugin to avoid duplicate registration).

## Requirements

- Obsidian **1.4.16** or newer (desktop).
- For Sherlock / Maigret / Social Analyzer: install those tools separately and set commands in plugin settings.
- For Social Analyzer (optional): clone [qeeqbox/social-analyzer](https://github.com/qeeqbox/social-analyzer) into `social-analyzer-main/` inside this plugin folder (see below).

## Install from GitHub (manual)

1. Download the latest release assets (`main.js`, `manifest.json`, `styles.css`) or clone this repository.
2. Copy the plugin folder to `Vault/.obsidian/plugins/comshit/`.
3. Enable **comshit** in **Settings → Community plugins**.
4. Configure Sherlock (and other tools) under **Settings → comshit**.

## Install from source

```bash
git clone https://github.com/comwhore/obsidian-comshit.git
cd obsidian-comshit
npm install
npm run build
```

Copy or symlink the folder into your vault’s `.obsidian/plugins/comshit/`.

## Optional: Social Analyzer files

Community plugin installs only ship `main.js`, `manifest.json`, and `styles.css`. Social Analyzer needs Python sources beside the plugin:

```bash
cd .obsidian/plugins/comshit
git clone --depth 1 https://github.com/qeeqbox/social-analyzer.git social-analyzer-main
```

Set **Python command** in settings (for example `python` or `py -3` on Windows).

## Usage

1. Open or create a Canvas file.
2. Use mindmap shortcuts on selected nodes.
3. Run OSINT from the command palette or the Canvas node context menu.
4. Configure CLI paths under **Settings → comshit**.

### Sherlock command examples (Windows)

- `python -m sherlock`
- `C:\Python311\python.exe -m sherlock`
- `C:\tools\sherlock\sherlock.exe`

## Markdown sync format

Paired markdown files use managed sections:

- `<!-- whereami:graph:start -->` … `<!-- whereami:graph:end -->`
- `<!-- whereami:preserve:start -->` … `<!-- whereami:preserve:end -->`

Content outside these blocks is preserved.

## Development

```bash
npm run dev    # watch build into main.js
npm run build  # production bundle (embeds excel-modded for marketplace installs)
```

Bump version for a release:

```bash
npm version patch   # or minor / major
git push && git push --tags
```

Tag names must match `manifest.json` `version` (for example `1.0.1`). GitHub Actions uploads release assets automatically.

## Publish to the Obsidian community store

1. Push this repository to GitHub (default branch with accurate `manifest.json` on HEAD).
2. Create a release whose tag equals `manifest.json` `version`, with assets `main.js`, `manifest.json`, `styles.css` (the workflow above does this on tag push).
3. Sign in at [community.obsidian.md](https://community.obsidian.md/), link GitHub, and submit **Plugins → New plugin** with your repo URL.
4. Address automated review feedback; publish when ready.

Plugin id: `comshit` (must stay unique in the directory).

## License

GNU General Public License v3.0 or later — see [LICENSE](LICENSE) and [COPYING](COPYING).
Spreadsheet code is derived from [obsidian-excel](https://github.com/ljcoder2015/obsidian-excel) (GPLv3).
Third-party notices: [NOTICE](NOTICE).

Use OSINT features responsibly and follow site terms of service and applicable law.
