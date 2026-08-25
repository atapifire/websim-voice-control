# Websim Voice Control

Hands-free Chrome voice control for text fields, Websim projects, the local
`websim-cli`, and an optional local Codex agent.

## What it does

- Starts/stops Chrome speech recognition from the popup.
- Supports Command Mode and Dictation Mode.
- Supports Websim Sleep/Wake, including “Web Sim” variants.
- Types into focused inputs, textareas, and contenteditable elements.
- Supports Say/Write, Enter, Tab, Backspace, Delete, Space, Select All, and
  Talon-style spoken alphabet names such as “air” = `a`.
- Shows separate Help and live Codex Terminal windows.
- Supports Alt Tab between accessible windows and Switch Tab within a window.
- Lists, searches, opens, and creates Websim projects.
- Opens projects as one new tab in the current browser window.
- Runs Websim CLI and optional local Codex tasks through Native Messaging.

## Basic Chrome installation

1. Download or clone this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the folder containing `manifest.json`.
5. Open a normal webpage with a text field.
6. Open the extension popup and click **Start listening**.
7. Approve microphone access if Chrome asks.

After an update, click **Reload** on the extension card and refresh any
already-open webpage. Chrome does not replace an existing content script until
its page is refreshed.

The extension cannot run on `chrome://` pages, the Chrome Web Store, or other
browser-restricted pages.

## Core voice commands

### Modes and safety

- `Command Mode`
- `Dictation Mode`
- `Websim Sleep` / `Web Sim Sleep`
- `Websim Wake` / `Web Sim Wake`
- `Help` / `Close Help`
- `Show Terminal` / `Hide Terminal`

While sleeping, commands are ignored except for Wake.

### Editing

- `Say hello` or `Write hello`
- `Enter`, `Tab`, `Backspace`, `Delete`, `Space`
- `Select All`
- Spoken alphabet names: `air`, `bee`, `see`, `dee`, and so on

### Windows and tabs

- `Alt Tab` or `Switch Window` cycles accessible normal and popup windows.
- `Switch Tab` cycles tabs in the selected browser window.
- `Scroll Down` and `Scroll Up` scroll the page or Help window.

## Websim project commands

- `Recent Projects`
- `Search Projects for space game`
- `Open Project 1`
- `Open Project project-id`
- `Open Project project-name`
- `New Project`

Project navigation opens one new tab in the current browser window. It does
not intentionally create a separate browser window.

## CLI and Codex commands

Requests beginning with `Codex`, `Ask Codex`, or `Agent` are instructed to use
the installed `websim-cli` for Websim operations. The extension owns browser
navigation: the agent returns a project URL and the extension opens it in one
tab.

- `Codex <instruction>` runs a local Codex task.
- `Codex Stop` cancels the active task.
- `List Codex Sessions` lists saved local Codex sessions.
- `Find Codex Sessions for websim` filters saved sessions.
- `Resume Codex Session 1` resumes a session from the current list.
- `Resume Last Codex Session` resumes the newest saved session.
- `CLI Login`
- `Clone Project <id>`
- `Pull Project`, `Sync Project`, `Push Project`, `Promote Project`
- `Create CLI Project`, `List CLI Projects`
- `Switch Model to Luna Low`
- `Set Reasoning Level to high`
- `What Model Am I Using?`

The Codex Terminal shows command events and output and includes a follow-up
prompt field. Its newest output stays anchored at the bottom, with older
output above it. TTS speaks meaningful status, agent messages, login state,
errors, and completion messages—not raw event JSON. Sessions are read from
the local Codex session store and resumed with the installed Codex CLI.

## Optional native bridge setup

Basic voice and Websim page features do not require the native bridge. CLI and
local Codex commands do.

### Requirements

- Linux, Chrome, and Node.js
- `websim-cli` installed and logged in:

  ```bash
  npm install --global websim-cli
  websim-cli login
  ```

- The `codex` CLI installed and authenticated for Codex commands.

### Register the host

1. Load the unpacked extension and copy its ID from `chrome://extensions`.
2. Edit `native-messaging-host.json`:
   - Replace `REPLACE_WITH_EXTENSION_ID` with your extension ID.
   - Change `path` to the absolute path of your copy of `native-host.js`.
3. Make the host executable:

   ```bash
   chmod +x /absolute/path/to/native-host.js
   ```

4. Copy the edited manifest to:

   ```text
   ~/.config/google-chrome/NativeMessagingHosts/com.websim.voicecontrol.json
   ```

5. Reload the extension and refresh the webpage.

The host searches common `/home/agent/.npm-global/bin` and `/usr/local/bin`
locations for `websim-cli`. Set `WEBSIM_CLI_BIN` or update `cliExecutable()` if
your CLI is elsewhere. Set `WEBSIM_CLI_CWD` for local pull/sync/push commands.

The host blocks browser-launch commands inside agent subprocesses so the
extension controls project navigation and prevents duplicate windows.

## Diagnostics

Open the popup and expand **Diagnostics** to view or clear recent extension
logs. If a native command fails, reload the extension and inspect the terminal
and diagnostics output.

## Privacy and limitations

- Speech recognition is provided by Chrome and depends on browser/OS support.
- The native bridge runs local commands with the host user’s permissions.
- Never publish `.websim-cli.json`, access tokens, logs, or credentials.
- This repository contains no Websim credentials or local project metadata.
- The local Codex CLI is separate from the ChatGPT/Codex agent in this chat.

## License

Add the license you want before redistributing this project. No license is
implied until one is added.
