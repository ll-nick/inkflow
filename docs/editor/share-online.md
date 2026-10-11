# Sharing online

[Sharing on the network](collaborate.md) works when everyone is on the same
network or VPN. **Sharing online** works from anywhere: you send a link, and
whoever opens it edits the deck with you (or watches you present), wherever
they are, with nothing to install. Your deck still stays on your computer.

## What the relay is

Your computer and your guests' browsers usually cannot reach each other
directly: home routers, office firewalls and mobile networks are in the way.
So both sides connect *out* to a small go-between on the internet, the
**relay**, which passes messages from one to the other. It is like a post
office for sealed envelopes: everything is encrypted on your computer and
opened only in your guest's browser (and the other way round). The relay
forwards the envelopes without being able to open them.

The relay is yours: a free Cloudflare Worker on your own Cloudflare account
(set up once, about ten minutes, below), or a small program on a server you
run. There is no inkflow service in between.

## What the relay (Cloudflare) sees, and what it does not

| The relay sees | The relay never sees |
|---|---|
| that a room exists, while you share | your slides, text, pictures, videos, notes |
| when people connect and leave, and from which IP address | names, who edits what, what anyone types |
| how many messages pass and how big they are | the links' keys (they are after the `#`, which browsers never send) |

Everything inside the messages is encrypted end to end (AES-256-GCM). The keys
come from the link itself: the part after `#` never leaves the browser that
opens it. Each link (editor, view) has its own key, so the relay cannot turn
a viewer into an editor, and you can tell them apart.

One honest caveat: the guest page itself (a few kilobytes of JavaScript that
opens the link) is served by the relay. With your own Cloudflare account or
server, that is your copy of inkflow's guest page, and you are trusting
Cloudflare (or your server) to serve the files you deployed.

## First-time setup with Cloudflare (free)

You need this once per computer you share from. It takes about ten minutes.

1. **Create a Cloudflare account** at
   [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up). The free
   plan is enough and asks for no credit card. Confirm your e-mail address.

2. **Install Node.js** (the *LTS* version) from
   [nodejs.org](https://nodejs.org). It brings `npx`, which runs Cloudflare's
   command-line tool, *wrangler*. Check it in a new terminal:

    ```bash
    npx --version
    ```

3. **Let wrangler use your Cloudflare account** (once):

    ```bash
    npx wrangler login
    ```

    A browser window opens; sign in to Cloudflare and click **Allow**. Back in
    the terminal it says you are logged in.

4. **Deploy the relay:**

    ```bash
    inkflow relay deploy cloudflare
    ```

    (If inkflow says sharing online needs one more package, install it first:
    `pip install 'inkflow[online]'`, or `uv tool install 'inkflow[online]'`.)

    This puts inkflow's relay on your account as a Worker named
    `inkflow-relay`. The first time, Cloudflare may ask you to pick a
    *workers.dev subdomain* (a name for your account's addresses, such as
    `ada`): answer in the terminal. At the end inkflow prints the relay's
    address, for example:

    ```text
    relay: https://inkflow-relay.ada.workers.dev
    ```

    and remembers it, together with a new **access token**: a password only
    your inkflow knows, so nobody else can open rooms on your relay. A brand
    new workers.dev address can take a minute or two to start answering.

5. **Check it** (optional):

    ```bash
    inkflow relay show
    ```

    says `health: answers` once the relay is up.

That is all. To update the relay after updating inkflow, run
`inkflow relay deploy cloudflare` again.

If you deployed some other way, or moved to a new computer, tell inkflow the
address (and the token, if the relay has one) with
`inkflow relay set https://inkflow-relay.ada.workers.dev --token TOKEN`, or
in the editor's **Share…** dialog under **Online**.

The token is not printed after a deploy that worked; inkflow keeps it in its
settings file (`relay.json` in `~/.config/inkflow/` on Linux,
`~/Library/Application Support/inkflow/` on macOS,
`%LOCALAPPDATA%\inkflow\inkflow\` on Windows). To see it, for a new computer or a
teammate who should share through the same relay:

```bash
inkflow relay show --token
```

prints the token and the whole `inkflow relay set … --token …` command to run
there. Lost it everywhere? Run `inkflow relay deploy cloudflare` on a computer
whose inkflow has no relay set: it deploys again with a new token, and
everyone else then needs the new one.

## Sharing

1. Open the deck in the editor (`inkflow edit`).
2. Click **Share…** (top right) and, under **Online**, click **Share online**.
3. After a moment the dialog shows two links:
    - the **online editor link**: whoever opens it edits the deck with you;
    - the **online view link**: whoever opens it watches the presentation,
      following your slide.

    Each has **Copy** and a QR code. Send the link by chat or e-mail.

Or start inkflow sharing already: `inkflow edit --share-online` prints both
links in the terminal.

Your guests open the link in any current browser (Chrome, Edge, Firefox,
Safari, on a computer, tablet or phone). The first time, the editor asks for
their name. From then on it is exactly like [editing
together](collaborate.md) on a network: the same roles, the same editor, their
selections in their colour, undo per person. An online guest can do what an
editor link allows and nothing more: never git, never other files or programs
on your computer.

**Stop sharing online** ends the room: everyone connected online sees
*Disconnected: sharing stopped*, and the links stop working. **New online
links** makes new links: everyone who joined with the old ones is
disconnected. Sharing online also stops when inkflow stops; the next time you
share, the links are new.

Sharing online and sharing on the network are independent: you can do either,
or both at once.

## What the free plan allows

Cloudflare's free plan is generous for this. As of writing:

- **100,000 Worker requests a day**, and Durable Objects (one per shared deck,
  which is what holds a room) have a daily allowance of their own;
- **WebSocket messages count 20 to 1**: twenty messages through the relay
  count as one request;
- **hibernation**: a room whose connections are idle (you think, nobody
  types) costs nothing while idle;
- **the guest page is static**: loading it is free and does not count.

A guest opening the editor is a few dozen messages; each edit is a handful per
person connected. An afternoon of editing with a few people stays far below
the free allowance. Check the current figures on Cloudflare's
[Workers pricing page](https://developers.cloudflare.com/workers/platform/pricing/)
and [Durable Objects pricing page](https://developers.cloudflare.com/durable-objects/platform/pricing/);
if you ever run over, the relay stops answering until the next day (the free
plan never bills you).

## Running the relay yourself

Any server with a public address and HTTPS can run the relay instead of
Cloudflare. On the server (with inkflow installed; the relay itself does not
need the `online` extra):

```bash
inkflow relay --port 8787 --access-token "$(openssl rand -base64 32)"
```

Remember the token you gave it. The relay must be reached over **HTTPS**
(browsers only allow the encryption and the guest page's helper on secure
pages). With [Caddy](https://caddyserver.com), which gets a certificate by
itself, the whole configuration is:

```text
relay.example.org {
    reverse_proxy localhost:8787
}
```

Keep `inkflow relay` running (a systemd service, `tmux`, a container). Then, on
your own computer:

```bash
inkflow relay set https://relay.example.org --token THE_TOKEN
```

`inkflow relay --help` lists its options (`--max-guests`, `--host`).

## Troubleshooting

**`npx wrangler login` fails or never finishes.** It opens a browser on your
computer; if the terminal is on another machine (over SSH), run
`inkflow relay deploy cloudflare` on your own computer instead. Behind a
company proxy, wrangler needs the proxy too: set `HTTPS_PROXY` before running
it.

**The deploy fails.** Read wrangler's message above inkflow's. Most often: not
logged in (`npx wrangler login`), the e-mail address of the Cloudflare account
not confirmed yet, or no workers.dev subdomain chosen (run the deploy again
and answer the question, or choose one on dash.cloudflare.com → Workers &
Pages). `inkflow relay deploy cloudflare --name another-name` deploys under
another name.

**The Share dialog says it cannot reach the relay**, or *the relay refused*.
Check `inkflow relay show`. *needs its access token*: the token inkflow has is
not the relay's; deploy again (which sets a new one) or set the right one with
`inkflow relay set URL --token TOKEN`. A new workers.dev address can take a
minute to work.

**A guest sees "Waiting for the person sharing the deck…".** Either you are
not sharing online right now (or inkflow restarted, which makes new links),
or you made new links since they got theirs: send them the current link.
When your connection drops for a moment, guests see the same message and
reconnect by themselves once you are back.

**A guest's page never loads.** Some company networks and proxies block
WebSockets: try another network, or a phone's hotspot. The browser must allow
*service workers*: Firefox turns them off in private windows, and some
browser settings ("block all cookies and site data") do too; a normal window
works.

**"The room is full".** A relay lets 50 people into a room at once (`inkflow
relay --max-guests` changes it for a relay you run; on Cloudflare, set the
`MAX_GUESTS` variable on the Worker).

**"Disconnected: new links"** or **"sharing stopped"**: the link no longer
works; ask for the current one.

## Security notes

- **A link is its key.** Anyone who has the editor link can edit the deck
  while you share, and anyone with the view link can watch. Send links only to
  the people meant to have them, over a channel you trust.
- **New online links** (or stopping and starting again) makes the old links
  useless at once. Do it after a session, or whenever a link went somewhere it
  should not.
- **Who is connected** is listed in the Share dialog (marked *online*), each
  with **Disconnect**.
- The links' keys never reach the relay, and are taken out of the guest's
  address bar as soon as the page has read them (they stay in that browser
  tab, so a reload works).
- Each connection gets keys of its own; every message is numbered, so a
  message replayed, dropped or reordered on the way ends that connection
  instead of being accepted.
- Guests with the *same* link share its key. Someone with the editor link who
  also controlled the relay could pretend to be you to another editor; they
  could edit the deck anyway, so this gives them nothing new.
- The access token keeps strangers from using your relay (and your free
  allowance). It is stored in your user config folder (`relay.json`), readable
  by you only.

## How it works

For the curious (and for running into its limits knowingly):

- inkflow (the *host*) holds a **room** on the relay. The room's name is a hash
  of a secret only your inkflow has, so a guest's link cannot hold the room.
- A guest's browser opens the **guest page** on the relay, reads the room and
  key from the link, and opens an encrypted channel to your inkflow:
  a handshake proves to the guest that it reached your inkflow (not the
  relay), and to your inkflow which link's key the guest has (its role).
- The guest page asks your inkflow for the real page (the editor or the
  presenter, of your inkflow's version) and shows it. Its pictures, fonts and
  videos are fetched through the same channel by the page's *service worker*;
  its live connection is the channel too. To your inkflow, each guest page is
  one more connection, with the same rules as on the network.
- Messages are split into frames of at most 512 KB, and what your inkflow
  sends is compressed before it is encrypted.
