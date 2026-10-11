# Editing together

Several people can work on one deck at the same time: you on your computer,
colleagues in the same room or on the same VPN through a share link, or all of
you through SSH tunnels to a server you can log in to. Everyone sees the others' edits within
a moment, who is on which slide, and what they have selected. Nothing is
uploaded anywhere: the deck stays on the computer that runs `inkflow edit`.

For people who are not on your network, [share online](share-online.md)
instead: the same links and roles, through an end-to-end encrypted relay on
your own (free) Cloudflare account or server.

## Who is who

There are three roles.

| Role | Who | Can |
|---|---|---|
| **Owner** | Anyone on the computer running inkflow (a browser there, a command, an agent, an [SSH tunnel](#over-ssh)); in [SSH mode](#ssh-mode) only whoever opened the owner link, and commands of the same user | Everything |
| **Editor** | Someone who opened an *editor link* | Edit the deck: slides, text, pictures, notes, ink, theme, export |
| **Viewer** | Someone who opened a *view link* | Watch the presentation; it follows the presenter's slide |

An editor changes the deck's own files, and nothing else on your computer. These
stay with the owner:

- opening files in other programs (**Open ▾**), the system file chooser, folder
  browsing, opening or creating other decks, the recent-decks list;
- git: commit, push, pull, switching branches and every other operation that
  writes (an editor still sees the status and history);
- worktrees (add, merge, remove), Git → Publish… setup, **Pack deck…**, copying
  this computer's fonts into the deck;
- inserting a file by its path on disk, exporting outside the deck's folder;
- the agents' context file and `inkflow goto`/`select`, the Share dialog, and
  **Quit Inkflow**.

An editor's edit never writes code or settings that your computer would run or
read: no Python modules, scripts or `.toml`/`.lock` files, and nothing in a hidden
folder (`.git/`, `.env`…). `deck.py` itself is changed only through the editor's
own structural edits, as for you.

A viewer gets the presenter page only: `/edit` answers *View-only link*, and
anything a viewer sends besides following along is ignored.

## On the same network (or VPN)

```bash
inkflow edit --share
```

prints two links for each address of this computer, and the same with its
`.local` name where the network resolves it:

```text
Sharing  edit  http://192.168.1.20:7777/edit?k=4ReDLi5Snm8Ihq9Yre7-KYBC
Sharing  view  http://192.168.1.20:7777/?k=unWSwLKvHD3PErKBFp2kBN-R
Sharing  also  http://laptop.local:7777 (same ?k= links)
```

The editor's **Share…** button (top right, for the owner only) does the same
without restarting: **Share on the network** starts listening on the network,
**Stop sharing** goes back to this computer only. The dialog shows each link with
**Copy** and a QR code to scan with a phone, and lists who is connected, each
with **Disconnect**. **New links** makes new ones: the old links stop working and
everyone who joined with them is disconnected.

A link is used once: opening it sets a cookie for this server and moves on to the
same address without the `?k=` part, so the token does not stay in the address
bar, the history or a screenshot. Links stop working when sharing stops or new
links are made; a guest then sees *Disconnected* and needs a new link.

Starting with `--host` set to one of this computer's network addresses also
shares: other machines can reach it, so they need a link.

### VPN and Tailscale

A VPN is a network like any other: with `--share` the links include the VPN
address (a Tailscale `100.x.y.z`, a WireGuard address). Use
`--host <address>` to listen on that address only, not on the local network:

```bash
inkflow edit --share --host 100.101.102.103
```

To use a name instead of the address (a Tailscale MagicDNS name, say), allow it:
inkflow refuses requests that name a host it does not know (see
[security](#security)).

```bash
inkflow edit --share --allow-host laptop.tail1234.ts.net
```

For HTTPS, `tailscale serve` can put the server behind the tailnet's
certificate. Requests then arrive from `tailscale serve` on this computer, so
they are not the owner's; they need a link like any guest:

```bash
inkflow edit --share --allow-host laptop.tail1234.ts.net
tailscale serve --bg 7777
# links: https://laptop.tail1234.ts.net/edit?k=… (the token from the Share dialog)
```

Or serve HTTPS yourself with a certificate and key, such as `tailscale cert`
writes:

```bash
tailscale cert laptop.tail1234.ts.net
inkflow edit --share --host 100.101.102.103 --allow-host laptop.tail1234.ts.net \
    --tls laptop.tail1234.ts.net.crt laptop.tail1234.ts.net.key
```

## Over SSH

When everyone involved can log in to one server (a lab machine, a workstation,
a rented box), the deck can run there once for all of you. Each person opens it
through an SSH tunnel of their own: nothing listens on the network, and the
pages, pictures, videos and the live connection all travel inside SSH on the
one port.

Usually three kinds of computers take part:

```text
 your computer                  the server                  a collaborator's computer
 a browser          ── SSH ──▶  runs inkflow       ◀── SSH ──  a browser
 (the owner link)    tunnel     holds the deck      tunnel    (an editor or view link)
                                (a git clone)
```

You set the server up once and open the deck as its owner
([Setting up the server](#setting-up-the-server)); then you invite people
([Inviting collaborators](#inviting-collaborators)). Collaborators install
nothing: no inkflow, no git, no copy of the deck. They need an SSH login on the
server and a browser. Give each their own login: someone logged in with your
account *is* you there (your files, your shell, your owner link).

In the editor, **Share… → Share via SSH** writes out every command below for
your deck (its repository, its folder, the port), each with **Copy**: on your
computer the setup steps, on the server the message for your collaborators.

### SSH mode

Everyone logged in to the server reaches its `localhost`, and so does everyone
who forwards a port to it. So when inkflow is started from an SSH login (it
sees `SSH_CONNECTION` or `SSH_CLIENT` in its environment) it runs in **SSH
mode**: being on the machine is not enough to be the owner. It prints an
**owner link**:

```text
SSH mode  being on this machine is not enough to edit: open the owner link, through your SSH tunnel
Owner  http://localhost:7777/edit?k=tb9XiVFCe8LZNRKhInLIWeUl
       open it through: ssh -L 7777:localhost:7777 you@203.0.113.5
```

Opening the owner link through your tunnel makes you the owner in that browser
(it sets a cookie, as share links do, but one of its own: trying a share link in
the same browser leaves you the owner; the token leaves the address bar). Opening
`http://localhost:7777/edit` without it answers *Open the owner link*. The owner
link stays the same while the server runs (**New links** does not change it);
starting inkflow again makes a new one.

`--ssh` turns SSH mode on wherever inkflow starts (inside `tmux` started
outside an SSH login, say), `--no-ssh` turns it off (a server only you can log
in to). Commands on the server (`inkflow slide`, `inkflow shape`, `inkflow
goto`…) keep working as the owner: they read the owner token from the
server's record in your user's state folder, which other users cannot read.

In SSH mode, turning the links on (**Turn on links**, or `--share`) never makes
the server listen on the network: the links name `localhost`, for each guest to
open through their own tunnel.

### Setting up the server

On your computer, once per deck (or whenever you want to work on the server
alone):

1. **Push your latest changes**: the server clones the deck from its
   repository (Git menu → Commit, then Push). A deck without a remote needs
   one first, such as an empty repository on GitHub or GitLab:

    ```bash
    git remote add origin <repository URL>
    git push -u origin main
    ```

2. **Log in with the port forwarded**:

    ```bash
    ssh -L 7777:localhost:7777 you@server.example.com
    ```

    To keep inkflow running when the connection drops, start
    `tmux new -A -s inkflow` (or `screen`) and run the next steps in it; the
    same command gets back to it after logging in again. A private repository:
    `ssh -A` lets the server clone with your own keys (whoever administers the
    server can use them while you are logged in), or clone with an HTTPS
    access token.

3. **Once, on the server**: install uv, inkflow and the deck:

    ```bash
    curl -LsSf https://astral.sh/uv/install.sh | sh
    source $HOME/.local/bin/env
    git clone git@github.com:you/talks.git talks
    cd talks
    ```

    When the deck's `pyproject.toml` pins inkflow (`inkflow init` writes one),
    `uv run` installs it the first time. Otherwise install it as a tool, at the
    version your deck runs on (the dialog writes it, such as
    `uv tool install 'inkflow~=0.7.0'`), and leave out `uv run` below.

4. **Start the editor**:

    ```bash
    uv run inkflow edit --no-open --ssh
    ```

    (`--deck keynote/deck.py` for a deck in a folder of the repository,
    `--port` for another port.) It prints the owner link. If port 7777 is
    taken on the server, it uses the next free one: log in again forwarding
    that one.

5. **On your computer, open the owner link** it printed. You are the owner
   there, editing the server's copy of the deck.

6. **When you are done**, commit and push on the server (its Git menu), then
   `git pull` on your computer.

Next time, one command logs in, updates the deck and starts the editor (it
stops when the connection closes):

```bash
ssh -t -L 7777:localhost:7777 you@server.example.com "bash -lc 'cd talks && git pull && uv run inkflow edit --no-open --ssh'"
```

To forward a different local port (7777 is busy on your computer), say
`ssh -L 8000:localhost:7777 …` and open the owner link with `8000` in place of
`7777`.

### Inviting collaborators

Each collaborator needs their own SSH login on the server, and nothing else. In the editor you
opened as the owner, **Share… → Share via SSH** turns the links on (**Turn on
links**) and writes a message for an editor and one for a viewer, with
**Copy**:

```text
To edit the deck with me (you need an SSH login on server.example.com):

1. In a terminal, run this, with your own login on server.example.com in place
   of <your-user>. Keep it open; it shows nothing. (On Windows, the same
   command works in PowerShell.)

   ssh -N -L 7777:localhost:7777 <your-user>@server.example.com

2. Open this link in your browser:

   http://localhost:7777/edit?k=4ReDLi5Snm8Ihq9Yre7-KYBC
```

*Server address* is prefilled with the address your own SSH login reached (or
the server's name); change it to the name people log in to. *Their local port*
changes both the command and the link, for a collaborator whose 7777 is busy:
`ssh -N -L 8000:localhost:7777 …` and `http://localhost:8000/edit?k=…` work
together.

Through their tunnel, someone with the editor link is an editor and someone
with the view link a viewer, with everything that [those roles](#who-is-who)
can and cannot do. Their SSH login does not make them the owner. **New links**
disconnects everyone holding the old ones, and **Stop sharing** everyone.

## Seeing each other

The first time you open an editor link, the editor asks for your name (kept in
that browser). Each person gets a colour:

- **avatars** in the toolbar, one per person with a page open (a dashed ring:
  presenting). Click someone's avatar to go to their slide, your own to change
  your name;
- **coloured dots** in the slide list on the slide each person is on;
- **their selection** outlined on the canvas in their colour, with their name
  (*typing* while they edit text).

Nothing of this is written to the deck; it disappears when they close the page.

## Undo is yours

<kbd>Ctrl</kbd>+<kbd>Z</kbd> takes back *your* latest change, not whatever
anyone did last. It does so only when no later change (anyone's) touched the
same file. Otherwise it says who changed it: *Ana changed features.md after
you: your edit cannot be undone without theirs*, and the Undo button's tooltip
says so beforehand. Ana can undo hers first, or you change it back by hand.
Redo works the same way.

Changes an agent makes on this computer (`inkflow slide`, `inkflow shape`) are
the owner's: only the owner's pages undo them.

## Two people, one file

Every change is checked against the version of the deck the page showed when you
made it. When someone else changed the same file in between, your change is
refused rather than written over theirs, and your editor is brought up to date
with a note: *Ana changed slides/drawing.svg meanwhile*. Drag or edit again.

Text you were typing is never lost. If someone changed the same text while you
typed, a box shows what you typed: **Copy** it, **Use mine instead** to put it
in place of theirs on purpose, or **Keep theirs**. If they changed something
else (another text on the same slide, the slide list), your text is saved as
usual.

## Security

- Without `--share` (and with the default `--host localhost`) the server listens
  on this computer only.
- Every request from another machine needs a link's token (or the cookie it set).
  Tokens are 144 random bits, compared in constant time, and never written in
  full to the logs.
- A web page from another site cannot use the server: the live connection only
  accepts pages the server served itself (its `Origin`), and every request must
  name this computer (its `Host`: `localhost`, an address, this computer's name
  or one given with `--allow-host`), so a site that points its own name at your
  computer (*DNS rebinding*) is refused.
- Without SSH mode, anyone who can reach `localhost` on this computer is the
  owner: other users logged in to the same machine too. On a machine other
  people log in to, use [SSH mode](#ssh-mode) (the default when inkflow starts
  from an SSH login): there only the owner link makes the owner, and commands
  read the owner token from a file only your user can read (`0600`, in a
  folder only you can open).
- In SSH mode the server never listens on the network, not even with the links
  on: a guest needs both a login on the server and a link.
- A browser sends the cookies of `localhost` to every port on it, so a program
  of yours listening on another local port could see an inkflow cookie. The
  tokens in them stop working when the server stops, when New links are made
  (guest links) or when sharing stops.
- Plain HTTP on a network you do not trust (café Wi-Fi, a conference) lets anyone
  on it read the links and the deck as they pass. Prefer SSH or a VPN there, or
  `--tls` with a certificate, or [share online](share-online.md), which is
  encrypted end to end whatever the network.
