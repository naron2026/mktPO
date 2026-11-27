# PO Messages Editor

An internal editor for gettext `.po` translation files: a small Node.js server
that reads and writes the files, and a React app in the browser.

## Run

Needs Node.js 20 or newer.

```sh
npm install
npm run dev                 # http://127.0.0.1:5173 (live reload while you change the code)
```

For everyday use, build once and run the production server:

```sh
npm run build
npm start
```

Settings (environment variables):

| Variable | Default | What it is |
|---|---|---|
| `PO_WORKSPACE` | `./workspace` | Folder with the `.po`/`.pot` files. Point it at your project's `locale/` folder to edit the files in place. |
| `PO_DATA` | `./data` | Where the shared team memory (`tm.json`) is kept. |
| `PORT` | `5173` | Port. |
| `HOST` | `127.0.0.1` | Use `0.0.0.0` to let others on the network use it. There is no login, so only do that on a trusted network. |

Example: `PO_WORKSPACE=~/code/app/locale npm start`

## Use

1. The start screen lists every `.po` and `.pot` in the workspace with its language and progress. Click one to open it, or **Import file** / drop a file to copy it into the workspace.
2. Translate. **Ctrl+Enter** marks a string done and jumps to the next unfinished one.
3. **Save** (Ctrl+S) writes the file on the server. If someone else saved it after you opened it, you are asked before it is overwritten.
4. **Build .mo** compiles the `.mo` next to the `.po` (same output as `msgfmt`) and offers it as a download.

## What it does

- Lists every string with its status: done, needs review (fuzzy) or untranslated, with filters and search.
- Highlights placeholders such as `%(name)s`, `%s`, `{name}` and warns when the translation drops or adds one, or when line breaks at the end do not match.
- Plural strings get one box per plural form of the language (Khmer, Malay: one box).
- Shows the developer's note, context, source references and the old source text of changed strings.
- Team memory, shared by everyone using the server: finished translations are suggested for similar strings in any file (Ctrl+1–4 to use one). **Pre-translate** fills untranslated strings that have an exact match and marks them for review.
- **AI suggestions** (optional): pick a provider (Anthropic, OpenAI, Google Gemini, or any OpenAI-compatible server such as Ollama or OpenRouter), a model and your API key under **AI** in the top bar. Each request sends the string, its notes and up to 8 team-memory translations as examples, so the AI keeps your terminology. Suggestions whose placeholders do not match are flagged. Ctrl+I asks for the selected string; you can also turn on asking automatically.
- **Update from .pot** brings in new strings after developers change screens: changed strings are filled from the closest old one and marked for review; removed ones are kept at the end as old (`#~`) entries.
- **Start a new language**: click a `.pot` on the start screen, pick the language and the file path. The plural rule is filled in for you.
- Unsaved work is kept as a draft in the browser and offered back on the start screen.

Saving only rewrites the strings you changed (plus the header dates), so diffs stay small.

## Keyboard

| Keys | Action |
|---|---|
| Ctrl+Enter | Done, go to next unfinished |
| Ctrl+S | Save |
| Alt+↑ / Alt+↓ | Previous / next string |
| Ctrl+U | Toggle needs review |
| Ctrl+B | Copy source text into the translation |
| Ctrl+1–4 | Use suggestion 1–4 |
| Ctrl+I | Ask the AI for a suggestion |
| Ctrl+F | Search |

## AI and API keys

The API key is never stored: not in the browser's storage, not on the server, not in logs. It is kept in the open tab's memory and sent to this editor's server with each AI request, which passes it to the provider for that one call. Reloading the page clears it. Provider, model and the auto-ask option are remembered in the browser.

If others use the server over the network (`HOST=0.0.0.0`), keys travel over plain HTTP to the server; put it behind HTTPS in that case.

## Code

- `shared/po.js`: parsing, writing, checks, `.pot` merge and `.mo` compiling, used by both the server and the browser.
- `server/index.js`: Express API (`/api/files`, `/api/file`, `/api/mo`, `/api/tm/*`, `/api/ai/*`). In development it also runs Vite.
- `server/ai.js`: AI suggestions through each provider's official SDK.
- `src/`: the React app (`App.jsx`, `components/`).
- `legacy/index.html`: the earlier single-file version that runs without a server.
