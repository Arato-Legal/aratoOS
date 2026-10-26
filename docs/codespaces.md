# Trying Mike in a GitHub Codespace

A Codespace is a temporary computer GitHub runs for you; it needs nothing
installed on your own machine. This is for **testing with made-up data only**:
sign-in confirmation is off, telemetry is off, and the bundled keys are public
demo keys.

## Start it

1. On the repository page choose **Code > Codespaces > Create codespace on
   main**. Pick the 4-core machine.
2. Wait. The first start builds everything and takes several minutes. When the
   terminal shows "Mike is starting", give it a few more minutes, then open the
   **Ports** tab and open port 3000. `docker compose ps` shows what is running.
3. Sign up with any made-up email and password.

Stop the Codespace when you finish (**Codespaces > Stop**). It keeps your data
until it is deleted, and an idle one stops itself.

## Keys (optional)

Chat, the assistant and web search need keys. Add them as **Codespaces
secrets** in your GitHub settings (Settings > Codespaces > Secrets), granted to
this repository, before you create the Codespace: `ANTHROPIC_API_KEY`
(or `OPENAI_API_KEY` or `GEMINI_API_KEY`) and, for web search,
`BRAVE_SEARCH_API_KEY`. Use keys with a low spending limit. Clients, contacts,
matter dashboards, tasks and notifications work with no keys.

## Document uploads

Uploads go from your browser straight to the storage service on port 9000, and
GitHub blocks that between private ports. To try uploads, right-click port 9000
in the **Ports** tab and set **Port Visibility > Public**, and set it back to
Private when you finish. The storage service uses a well-known demo password,
so never leave it public and never upload real documents.

## Cost

Personal GitHub accounts get a free monthly allowance of Codespaces time
(about 30 hours on a 4-core machine). Codespaces owned by an organisation are
billed to the organisation; GitHub shows who pays when you create one.

## What is not covered

Google Drive needs a Google Cloud sign-in app (OAuth client) with this
Codespace's address as a redirect, which changes with every new Codespace, so
it is awkward here. The Hubflo webhook can be tried with `curl` against the
Codespace's address on port 3000.
