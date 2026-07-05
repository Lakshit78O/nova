# Nova — AI Chat, powered by a hand-rolled LangChain-style pipeline + NVIDIA Mistral Nemo

A minimalist white-and-red chat app. Every file — frontend and backend — runs
as-is. **No npm, no `npm install`, no `node_modules`, no `package.json`.**

## The honest tradeoff

The real `langchain` package can only be obtained through npm — there's no
way around that if you want the actual library. Since you don't want npm
touching this machine at all, `backend/langchainClient.js` instead hand-writes
the same three-stage shape LangChain uses (prompt → model → parser), using
only Node's built-in `https` module. It's not the `langchain` package — it's
a small, transparent stand-in for it that teaches the same pattern.

Everything else is unchanged: `server.js` uses only Node's built-in `http`,
`fs`, and `path` modules (no Express), and there's a 20-line hand-rolled
`.env` reader in place of the `dotenv` package.

**The only command you'll ever run is `node server.js`.**

## Folder structure

```
nova/
├── backend/
│   ├── server.js            # Built-in http server: static files + /api/chat
│   ├── langchainClient.js   # Hand-rolled prompt/model/parser chain, streams tokens
│   └── .env.example         # copy to .env and add your NVIDIA_API_KEY
├── frontend/
│   ├── index.html           # Home / landing page
│   ├── chat.html             # Chat interface
│   ├── css/
│   │   ├── variables.css    # colors, type, motion tokens
│   │   ├── style.css        # shared nav/footer + home page styles
│   │   └── chat.css         # chat-specific layout & bubble styles
│   └── js/
│       ├── main.js          # home page load/scroll animations
│       └── chat.js          # chat logic: streaming fetch + Markdown rendering
└── README.md
```

No `package.json` anywhere — there's nothing to install, so there's nothing
for it to declare.

## Setup

1. **Get an NVIDIA API key** — sign in at https://build.nvidia.com, open any
   model page, and click "Get API Key". Keys look like `nvapi-...`.

2. **Configure the backend**
   ```bash
   cd nova/backend
   cp .env.example .env
   # open .env and paste your key in place of the placeholder
   ```

3. **Run it — no install step**
   ```bash
   node server.js
   ```
   You should see: `✨ Nova is running at http://localhost:3000`

   (Any recent Node.js works — version 18 or newer is safest, since the
   code uses `for await...of` over an HTTP stream, which needs a modern
   Node version. Run `node -v` to check what you have.)

4. **Open the app** — go to `http://localhost:3000` in your browser. The
   same server handles both the API and the static site, so there's no
   separate frontend process and no CORS to configure.

## Troubleshooting

- If Nova returns a backend error and the console logs show a 404 from the
  NVIDIA endpoint, your API key is valid but may not be provisioned for the
  chat/completions integration on that account.
- Make sure you generated your key from https://build.nvidia.com and that the
  key has access to the requested model.
- If needed, sign in again and create a new NVIDIA NIM API key, then paste it
  into `backend/.env`.

## How the pipeline works (for your own reading)

`langchainClient.js` is built from three small classes, chained together
by one function at the bottom of the file:

```
NovaPromptTemplate.format()   →   ChatNVIDIA.stream()   →   StringOutputParser.parse()
 (adds the system prompt          (opens an HTTPS request      (unwraps each
  in front of the running          to NVIDIA, parses the        { content } chunk
  conversation)                    Server-Sent-Events stream     down to plain text)
                                   it sends back, yields
                                   { content } chunks one
                                   at a time)
```

This mirrors real LangChain's shape on purpose: a **prompt stage** builds
the request, a **model stage** talks to the API and streams back
message-like chunks, and an **output parser stage** simplifies those
chunks into the plain strings the rest of the app actually wants. If you
later decide npm is fine after all, swapping this file for the real
`@langchain/openai` + `@langchain/core` packages is a drop-in change —
`streamNovaResponse()` in `server.js`'s eyes looks identical either way.

The NVIDIA-specific part lives in `openNvidiaStream()` and
`parseSseTextDeltas()`: NVIDIA's API streams replies as
Server-Sent-Events — lines like `data: {"choices":[{"delta":{"content":"Hi"}}]}`
ending in `data: [DONE]`. That function reads the raw HTTPS response as it
arrives and pulls the text out of each event as soon as it's complete,
which is what makes Nova's reply appear to type itself in the browser.

`server.js` calls `streamNovaResponse(messages)`, which is an **async
generator** — a function that `yield`s values one at a time instead of
returning everything at once. Each `yield` is immediately `res.write()`-ed
to the browser.

## Design notes

- Palette: warm white (`#FBFAF9`) base, near-black ink text, one confident
  red accent (`#E31934`) — no gradients-for-the-sake-of-it, no dark mode
  default.
- Signature element: the **Nova mark** — a small pulsing burst (a nova: a
  star that suddenly, briefly flares). It's the logo, and it doubles as the
  chat page's "thinking" indicator, so the brand's name is literally what
  happens while the AI is working.
- Fonts: Space Grotesk (headings) + Inter (body) + IBM Plex Mono (labels/code),
  loaded from Google Fonts — swap the `<link>` tags if you'd rather
  self-host.

## Changing the model

Nova uses `mistral-nemotron`. To swap models, edit the one line near the
top of `backend/langchainClient.js`:

```js
const MODEL_NAME = "mistral-nemotron";
```

...to any other model id listed on https://build.nvidia.com.
