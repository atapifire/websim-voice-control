(() => {
  const CONTENT_VERSION = 'terminal-routing-2026-08-25-1';
  if (window.__websimVoiceControl) return;
  // A content script already loaded on a page is not replaced when the
  // extension is reloaded. Record the version so the popup/background setup
  // can detect stale page instances and ask the user to refresh that tab.
  window.__websimVoiceControl = true;
  window.__websimVoiceControlVersion = CONTENT_VERSION;

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const state = { listening: false, sleeping: false, mode: 'command', interim: '' };
  let recognition;
  let restarting = false;

  const indicator = document.createElement('div');
  indicator.id = 'websim-voice-indicator';
  indicator.hidden = true;
  document.documentElement.appendChild(indicator);

  const alphabet = {
    air: 'a', ay: 'a', bee: 'b', be: 'b', sea: 'c', see: 'c', dee: 'd',
    e: 'e', ee: 'e', eff: 'f', gee: 'g', he: 'h', hay: 'h', eye: 'i',
    jay: 'j', kay: 'k', el: 'l', ell: 'l', em: 'm', en: 'n', oh: 'o',
    pee: 'p', cue: 'q', queue: 'q', ar: 'r', ess: 's', tee: 't', you: 'u',
    vee: 'v', doubleyou: 'w', ex: 'x', why: 'y', zed: 'z', zee: 'z'
  };
  let projectResults = [];

  function updateIndicator(text = '') {
    indicator.hidden = !state.listening;
    indicator.className = state.sleeping ? 'sleeping' : (text === 'error' ? 'error' : '');
    indicator.textContent = state.sleeping ? 'Websim asleep' : `Websim ${state.mode}${text ? ` · ${text}` : ''}`;
  }

  function getState() { return { ...state, interim: undefined }; }

  function focusedEditable() {
    const el = document.activeElement;
    if (!el) return null;
    if (el.matches('textarea, input:not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]), [contenteditable]:not([contenteditable="false"])')) return el;
    return null;
  }

  function insertText(text) {
    const el = focusedEditable();
    if (!el) return false;
    if (el.isContentEditable) {
      document.execCommand('insertText', false, text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    } else {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? start;
      el.setRangeText(text, start, end, 'end');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
    return true;
  }

  function speak(text) {
    if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }

  function speakProgress(text) {
    if (!text || !('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) return;
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }

  function log(message, details = {}) {
    chrome.runtime.sendMessage({ type: 'voice-log', message, details });
  }

  function showHelp() {
    chrome.runtime.sendMessage({ type: 'open-ui', view: 'help' });
    helpPanel.hidden = false;
    helpPanel.style.display = 'grid';
    helpHost.style.display = 'block';
    log('Help opened');
  }

  function closeHelp() {
    chrome.runtime.sendMessage({ type: 'close-ui', view: 'help' });
    helpPanel.hidden = true;
    helpPanel.style.display = 'none';
    helpHost.style.display = 'none';
    log('Help closed');
  }

  const terminalPanel = document.createElement('section');
  const terminalHost = document.createElement('div');
  terminalHost.id = 'websim-codex-terminal-host';
  terminalHost.style.cssText = 'position:fixed!important;inset:0!important;z-index:2147483646!important;display:none;pointer-events:none!important;';
  const terminalShadow = terminalHost.attachShadow({ mode: 'open' });
  const terminalStyles = document.createElement('style');
  terminalStyles.textContent = `
    section { position: fixed; right: 18px; bottom: 18px; z-index: 2147483647; display: flex; width: min(720px, calc(100vw - 36px)); max-height: 65vh; color: #d6f7df; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; pointer-events: auto; }
    .card { display:flex; flex:1; min-width:0; flex-direction:column; overflow:hidden; border:1px solid #4d8f61; border-radius:12px; background:#07130b; box-shadow:0 12px 48px #000b; }
    header { display:flex; justify-content:space-between; padding:9px 12px; background:#10291a; color:#a5e9b2; font:600 12px system-ui,sans-serif; }
    button { border:0; background:transparent; color:#c9f5d0; font-size:20px; line-height:1; cursor:pointer; }
    pre { min-height:100px; max-height:58vh; margin:0; padding:12px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; }
  `;
  terminalShadow.appendChild(terminalStyles);
  terminalPanel.id = 'websim-codex-terminal';
  terminalPanel.hidden = true;
  terminalPanel.innerHTML = `
    <div class="card" role="dialog" aria-label="Codex terminal">
      <header><strong>Codex Agent Terminal</strong><button type="button" class="close" aria-label="Hide terminal">×</button></header>
      <pre class="output">Waiting for a Codex task…</pre>
    </div>`;
  terminalShadow.appendChild(terminalPanel);
  document.documentElement.appendChild(terminalHost);
  const terminalOutput = terminalPanel.querySelector('.output');
  terminalPanel.querySelector('.close').addEventListener('click', () => hideTerminal());

  function showTerminal() {
    // A Codex request should never leave the page-level Help overlay covering
    // the terminal. The Help popup remains independently tracked if it was
    // opened as a separate window.
    helpPanel.hidden = true;
    helpPanel.style.display = 'none';
    helpHost.style.display = 'none';
    chrome.runtime.sendMessage({ type: 'open-ui', view: 'terminal' });
    terminalPanel.hidden = false;
    terminalPanel.style.display = 'flex';
    terminalHost.style.display = 'block';
  }

  function hideTerminal() {
    chrome.runtime.sendMessage({ type: 'close-ui', view: 'terminal' });
    terminalPanel.hidden = true;
    terminalPanel.style.display = 'none';
    terminalHost.style.display = 'none';
  }

  function terminalLine(text) {
    const line = `[${new Date().toLocaleTimeString()}] ${text}`;
    terminalOutput.textContent = `${terminalOutput.textContent === 'Waiting for a Codex task…' ? '' : `${terminalOutput.textContent}\n`}${line}`.trim();
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
  }

  function runCli(args, label) {
    log('CLI command requested', { args });
    chrome.runtime.sendMessage({ type: 'run-websim-cli', args }, response => {
      const error = chrome.runtime.lastError?.message || response?.error;
      if (error || !response?.ok) {
        log('CLI command failed', { args, error });
        speak(`Websim CLI is unavailable. ${error || 'Install and connect the native host.'}`);
        return;
      }
      const output = `${response.stdout || ''}`.trim().replace(/\s+/g, ' ');
      speak(output ? `${label}. ${output.slice(0, 260)}` : `${label}.`);
    });
  }

  function runCodexAgent(prompt) {
    const agentPrompt = `Act as the Websim execution agent. This is a Websim voice-control extension, so all Websim project creation, listing, opening, and project operations MUST use the installed websim-cli at /home/agent/.npm-global/bin/websim-cli. Carry out the instruction instead of only explaining it. If authentication is required, run websim-cli login and continue after login. Do not use Websim browser APIs for the operation. Do not run xdg-open, open, window.open, window.location, or browser automation for the final project, and do not create a new browser window. Print the complete final project URL on a line beginning WEBsim_URL: so the extension can open exactly one new tab in the current browser window. ${prompt}`;
    log('Codex agent request', { prompt: agentPrompt });
    terminalOutput.textContent = '';
    showTerminal();
    terminalLine(`> ${prompt}`);
    chrome.runtime.sendMessage({ type: 'run-codex-agent', prompt: agentPrompt }, response => {
      const error = chrome.runtime.lastError?.message || response?.error;
      if (error || !response?.ok) {
        speak(`Codex agent is unavailable. ${error || 'Check Codex CLI login and native host setup.'}`);
        return;
      }
      speak('Codex is working on it.');
    });
  }

  function stopCodexAgent() {
    terminalLine('> stop requested');
    chrome.runtime.sendMessage({ type: 'stop-codex-agent' }, response => {
      speak(response?.ok ? 'Stopping Codex.' : 'No Codex task is running.');
    });
  }

  const helpHost = document.createElement('div');
  helpHost.id = 'websim-voice-help-host';
  helpHost.style.cssText = 'position:fixed!important;inset:0!important;z-index:2147483647!important;display:none;pointer-events:auto!important;';
  const helpShadow = helpHost.attachShadow({ mode: 'open' });
  const helpStyles = document.createElement('style');
  helpStyles.textContent = `
    :host { all: initial; }
    section { position: fixed; inset: 0; display: grid; place-items: center; padding: 24px; background: rgba(16,19,26,.82); color: #f3f5f7; font: 14px/1.45 system-ui,sans-serif; }
    .card { position: relative; width: min(520px, calc(100vw - 48px)); max-height: 80vh; overflow: auto; padding: 24px; border: 1px solid #ffffff33; border-radius: 16px; background: #171c27; box-shadow: 0 12px 48px #0008; }
    h2 { margin: 0 32px 16px 0; font-size: 20px; } p { margin: 10px 0; } .note { color: #aeb8c8; font-size: 12px; }
    .close { position:absolute; top:12px; right:14px; border:0; background:transparent; color:#fff; font-size:28px; cursor:pointer; }
  `;
  helpShadow.appendChild(helpStyles);
  const helpPanel = document.createElement('section');
  helpPanel.id = 'websim-voice-help';
  helpPanel.hidden = true;
  helpPanel.style.display = 'none';
  helpPanel.innerHTML = `
    <div class="card" role="dialog" aria-label="Websim voice commands">
      <button class="close" type="button" aria-label="Close help">×</button>
      <h2>Websim Voice Commands</h2>
      <p><b>Listening:</b> Start/stop listening from the extension popup.</p>
      <p><b>Modes:</b> “Command Mode”, “Dictation Mode”</p>
      <p><b>Editing:</b> “Say hello”, “Write hello”, “Select All”, “Delete”, “Enter”, “Tab”, “Backspace”, “Space”</p>
      <p><b>Sleep:</b> “Websim Sleep” / “Web Sim Sleep”, then “Websim Wake” / “Web Sim Wake”</p>
      <p><b>Projects:</b> “Recent Projects”, “Search Projects for …”, “Open Project …”, “New Project”</p>
      <p><b>CLI:</b> “CLI Login”, “Clone Project …”, “Pull Project”, “Sync Project”, “Push Project”, “Promote Project”, “Create CLI Project”, “List CLI Projects”</p>
      <p><b>Codex:</b> “What model am I using?”, “What models are available?”, “Switch model …”</p>
      <p><b>Reasoning:</b> “Set reasoning level to low/medium/high/xhigh”</p>
      <p><b>Agent:</b> “Ask Codex …” runs a local Codex CLI agent with Websim CLI available.</p>
      <p><b>Terminal:</b> “Show Terminal”, “Hide Terminal”. The terminal opens automatically for Codex tasks.</p>
      <p><b>Help:</b> “Help” and “Close Help”</p>
      <p class="note">CLI commands require the installed websim-cli native-messaging host.</p>
    </div>`;
  helpShadow.appendChild(helpPanel);
  document.documentElement.appendChild(helpHost);
  helpPanel.querySelector('.close').addEventListener('click', closeHelp);

  function projectList(payload) {
    if (Array.isArray(payload)) return payload;
    const items = payload?.projects?.data || payload?.data?.projects?.data || payload?.data || payload?.items || payload?.results || [];
    return Array.isArray(items) ? items.map(item => item?.project ? { ...item.project, ...item } : item) : [];
  }

  function projectTitle(project) {
    return project.title || project.name || project.slug || project.id || 'Untitled project';
  }

  function projectUrl(project) {
    const link = project.url || project.link_url || project.versioned_link_url;
    if (link) return new URL(link, 'https://websim.com/').href;
    return `https://websim.com/p/${encodeURIComponent(project.id)}`;
  }

  function showProjectResults(title, projects) {
    projectResults = projects;
    helpPanel.hidden = false;
    const card = helpPanel.querySelector('.websim-voice-help-card');
    card.querySelector('.websim-project-results')?.remove();
    const list = document.createElement('div');
    list.className = 'websim-project-results';
    const heading = document.createElement('h3');
    heading.textContent = title;
    list.appendChild(heading);
    if (!projects.length) {
      const empty = document.createElement('p');
      empty.textContent = 'No projects found.';
      list.appendChild(empty);
    } else {
      projects.forEach((project, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = `${index + 1}. ${projectTitle(project)}`;
        button.addEventListener('click', () => { openProject(projectTitle(project)); });
        list.appendChild(button);
      });
    }
    card.appendChild(list);
  }

  async function fetchProjects(query = '', mine = false) {
    const params = new URLSearchParams({ first: '8', sort_by: 'updated_at' });
    if (query) params.set('query', query);
    const endpoint = mine ? '/users/me/projects' : '/projects';
    const response = await fetch(`https://api.websim.com/api/v1${endpoint}?${params}`, { credentials: 'include' });
    if (!response.ok) throw new Error(`Websim API returned ${response.status}`);
    return projectList(await response.json());
  }

  async function listRecentProjects() {
    try {
      let projects;
      try { projects = await fetchProjects('', true); }
      catch { projects = await fetchProjects(); }
      showProjectResults('Recent Websim projects', projects);
      speak(projects.length ? `Recent projects: ${projects.slice(0, 5).map(projectTitle).join(', ')}.` : 'No recent projects found.');
    } catch (error) {
      speak('I could not retrieve Websim projects. Please make sure you are signed in.');
    }
  }

  async function searchProjects(query) {
    try {
      const projects = await fetchProjects(query);
      showProjectResults(`Projects matching “${query}”`, projects);
      speak(projects.length ? `I found ${projects.length} projects. ${projects.slice(0, 5).map(projectTitle).join(', ')}.` : `I found no projects matching ${query}.`);
    } catch (error) {
      speak('I could not search Websim projects. Please make sure you are signed in.');
    }
  }

  function openProject(target) {
    const number = Number.parseInt(target, 10);
    const match = Number.isInteger(number) && number > 0
      ? projectResults[number - 1]
      : projectResults.find(project => projectTitle(project).toLowerCase().includes(target.toLowerCase()));
    const url = match ? projectUrl(match) : (/^https?:\/\//i.test(target) ? target : `https://websim.com/p/${encodeURIComponent(target)}`);
    chrome.runtime.sendMessage({ type: 'open-project-tab', url }, response => {
      speak(response?.ok ? 'The project is open in a new browser tab.' : 'I could not open that project.');
    });
  }

  function openNewProject() {
    if (location.hostname === 'websim.com' || location.hostname.endsWith('.websim.com')) {
      const createButton = [...document.querySelectorAll('button, a, [role="button"]')]
        .find(element => /^(start creating|create|new project|create project)$/i.test(element.textContent.trim()));
      if (createButton) {
        createButton.click();
        speak('Starting a fresh Websim project.');
        return;
      }
    }
    window.open('https://websim.com/', '_blank', 'noopener');
    speak('I opened Websim in a new tab so you can create a fresh project.');
  }

  function selectAll() {
    const el = focusedEditable();
    if (!el) return false;
    if (el.isContentEditable) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
    } else if (typeof el.select === 'function') {
      el.select();
    }
    return true;
  }

  function pressKey(key) {
    const el = focusedEditable() || document.activeElement || document.body;
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key, code: key === 'Enter' ? 'Enter' : key, bubbles: true, cancelable: true }));
    }
    // Synthetic keyboard events do not invoke the browser's editing behavior.
    // Apply the editing actions explicitly where that is safe and predictable.
    if (key === 'Backspace') {
      if (el.isContentEditable) {
        document.execCommand('delete', false);
      } else if ('value' in el && typeof el.selectionStart === 'number') {
        const start = el.selectionStart;
        const end = el.selectionEnd;
        if (start !== end) el.setRangeText('', start, end, 'end');
        else if (start > 0) el.setRangeText('', start - 1, start, 'end');
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      }
    }
    if (key === 'Delete') {
      if (el.isContentEditable) {
        document.execCommand('forwardDelete', false);
      } else if ('value' in el && typeof el.selectionStart === 'number') {
        const start = el.selectionStart;
        const end = el.selectionEnd;
        if (start !== end) el.setRangeText('', start, end, 'end');
        else if (start < el.value.length) el.setRangeText('', start, start + 1, 'end');
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentForward' }));
      }
    }
    if (key === 'Enter' && el.matches?.('textarea')) insertText('\n');
    return true;
  }

  function normalize(text) {
    return text.trim()
      .replace(/[.!?]+$/, '')
      .toLowerCase()
      // Speech recognition may split the product name into two words.
      .replace(/\bweb\s+sim\b/g, 'websim');
  }

  function command(text) {
    const raw = text.trim();
    const normalized = normalize(raw);
    if (normalized === 'websim sleep') { state.sleeping = true; updateIndicator(); speak('Websim is sleeping'); return; }
    if (normalized === 'websim wake') { state.sleeping = false; updateIndicator(); speak('Websim has awoken'); return; }
    if (state.sleeping) return;
    if (normalized === 'scroll down' || normalized === 'scroll down one page' || normalized === 'page down') {
      window.scrollBy({ top: Math.max(window.innerHeight * 0.8, 300), behavior: 'smooth' });
      chrome.runtime.sendMessage({ type: 'scroll-ui', direction: 'down' });
      return;
    }
    if (normalized === 'scroll up' || normalized === 'scroll up one page' || normalized === 'page up') {
      window.scrollBy({ top: -Math.max(window.innerHeight * 0.8, 300), behavior: 'smooth' });
      chrome.runtime.sendMessage({ type: 'scroll-ui', direction: 'up' });
      return;
    }
    if (normalized === 'alt tab' || normalized === 'alt tab again' || normalized === 'switch window') {
      chrome.runtime.sendMessage({ type: 'cycle-window' }, response => { if (response?.ok) speak('Switched window.'); });
      return;
    }
    if (normalized === 'switch tab' || normalized === 'next tab' || normalized === 'control tab' || normalized === 'ctrl tab') {
      chrome.runtime.sendMessage({ type: 'switch-tab' }, response => speak(response?.ok ? 'Switched tab.' : (response?.reason || 'No other tab is open.')));
      return;
    }
    if (normalized === 'help' || normalized === 'show help' || normalized === 'open help' || normalized === 'show commands' || normalized === 'voice help' || normalized === 'commands') { showHelp(); return; }
    if (/^(?:close|hide|dismiss)(?: the)? help(?: menu| overlay)?$/.test(normalized)) { closeHelp(); return; }
    if (normalized === 'show terminal' || normalized === 'show codex terminal' || normalized === 'open terminal') { showTerminal(); return; }
    if (normalized === 'hide terminal' || normalized === 'hide codex terminal' || normalized === 'close terminal') { hideTerminal(); return; }
    if (normalized === 'codex stop' || normalized === 'stop codex' || normalized === 'agent stop') { stopCodexAgent(); return; }
    const askCodex = normalized.match(/^(?:ask codex|codex|agent)\s+(.+)$/);
    if (askCodex) { runCodexAgent(`Use the installed websim-cli where appropriate. ${askCodex[1]}`); return; }
    const setModel = normalized.match(/^(?:switch|change) (?:codex )?(?:model|mode) to\s+(luna|terra|sol|[a-z0-9][a-z0-9.-]*)(?:\s+(?:with|at)?\s*(low|medium|high|xhigh))?$/);
    if (setModel) {
      const reasoning = setModel[2] || 'medium';
      const aliases = { luna: 'gpt-5.6-luna', terra: 'gpt-5.6-terra', sol: 'gpt-5.6-sol' };
      const model = aliases[setModel[1]] || setModel[1];
      chrome.runtime.sendMessage({ type: 'set-codex-model', model, reasoning }, () => speak(`Codex agent is set to ${setModel[1]}, ${reasoning} reasoning.`));
      return;
    }
    const setReasoning = normalized.match(/^(?:set|switch|change) (?:codex )?reasoning(?: level)? to\s+(low|medium|high|xhigh)$/);
    if (setReasoning) {
      const reasoning = setReasoning[1];
      chrome.runtime.sendMessage({ type: 'set-codex-reasoning', reasoning }, () => speak(`Reasoning level set to ${reasoning}.`));
      return;
    }
    if (normalized === 'what model am i using' || normalized === 'what model is selected' || normalized === 'current codex model') {
      chrome.runtime.sendMessage({ type: 'get-codex-model' }, response => {
        if (!response?.model) { speak('The local Codex model is not configured.'); return; }
        const name = response.model.split('-').pop().replace(/^./, letter => letter.toUpperCase());
        speak(`${name}, ${response.reasoning || 'configured'} reasoning.`);
      });
      return;
    }
    if (normalized === 'what models are available' || normalized === 'list available models') {
      speak('The local Codex CLI supports its configured model catalog. Say switch model to followed by a model name to set the next agent request.');
      return;
    }
    if (normalized === 'cli login' || normalized === 'websim cli login') { runCli(['login'], 'Websim CLI login started'); return; }
    const clone = normalized.match(/^(?:clone|download) project\s+(.+)$/);
    if (clone) { runCli(['clone', clone[1]], 'Project clone started'); return; }
    if (normalized === 'pull project' || normalized === 'websim cli pull') { runCli(['pull'], 'Project pull started'); return; }
    if (normalized === 'sync project' || normalized === 'websim cli sync') { runCli(['sync'], 'Project sync started'); return; }
    const push = normalized.match(/^push project(?:\s+(.+))?$/);
    if (push) { runCli(push[1] ? ['push', push[1]] : ['push'], 'Project push started'); return; }
    const promote = normalized.match(/^promote project(?:\s+(.+))?$/);
    if (promote) { runCli(promote[1] ? ['promote', promote[1]] : ['promote'], 'Project promote started'); return; }
    if (normalized === 'create cli project' || normalized === 'create local project') { runCli(['create'], 'CLI project creation started'); return; }
    if (normalized === 'list cli projects' || normalized === 'list my cli projects') { runCli(['projects', 'list-current'], 'CLI project list requested'); return; }
    if (/^(?:recent|list|show) projects$/.test(normalized) || normalized === 'what are my recent projects') { listRecentProjects(); return; }
    const search = normalized.match(/^(?:search|find) projects?(?: for)?\s+(.+)$/);
    if (search) { searchProjects(search[1]); return; }
    const open = normalized.match(/^(?:open|switch to|go to) project\s+(.+)$/);
    if (open) { openProject(open[1]); return; }
    if (/^(?:new|create|fresh)(?: a)? project$/.test(normalized) || normalized === 'create a fresh project') { openNewProject(); return; }
    if (normalized === 'command mode') { state.mode = 'command'; updateIndicator(); return; }
    if (normalized === 'dictation mode') { state.mode = 'dictation'; updateIndicator(); return; }
    if (state.mode === 'dictation') { insertText(raw + ' '); return; }

    const say = raw.match(/^(?:say|write)\s+(.+)$/i);
    if (say) { insertText(say[1]); return; }
    if (normalized === 'enter' || normalized === 'press enter') { pressKey('Enter'); return; }
    if (normalized === 'tab' || normalized === 'press tab') { pressKey('Tab'); return; }
    if (normalized === 'backspace') { pressKey('Backspace'); return; }
    if (normalized === 'delete' || normalized === 'press delete') { pressKey('Delete'); return; }
    if (normalized === 'select all') { selectAll(); return; }
    if (normalized === 'space') { insertText(' '); return; }
    if (alphabet[normalized]) { insertText(alphabet[normalized]); return; }
    if (normalized.startsWith('letter ')) {
      const letters = normalized.slice(7).split(/\s+/).map(word => alphabet[word] || word).join('');
      insertText(letters);
    }
  }

  function startRecognition() {
    if (!SpeechRecognition || recognition || !state.listening) return;
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = 'en-US';
    recognition.onresult = event => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) command(event.results[i][0].transcript);
      }
    };
    recognition.onerror = event => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        state.listening = false;
        updateIndicator('error');
      }
    };
    recognition.onend = () => {
      recognition = null;
      if (state.listening && !restarting) {
        restarting = true;
        setTimeout(() => { restarting = false; startRecognition(); }, 250);
      }
    };
    recognition.start();
    updateIndicator();
  }

  function stopRecognition() {
    state.listening = false;
    if (recognition) recognition.stop();
    recognition = null;
    updateIndicator();
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'codex-progress') {
      if (message.kind === 'progress' && message.text) {
        terminalLine(message.text);
        if (message.speak) speakProgress(message.speakText || message.text);
      }
      if (message.kind === 'login-required' && message.text) {
        terminalLine(message.text);
        if (message.speak) speakProgress(message.text);
      }
      if (message.kind === 'login-complete' && message.text) {
        terminalLine(message.text);
        if (message.speak) speakProgress(message.text);
      }
      if (message.kind === 'codex-done') {
        if (message.stdout) terminalLine(message.stdout.slice(-4000));
        if (!message.ok) speak(message.error === 'Cancelled by user' ? 'Codex stopped.' : `Codex stopped with an error. ${message.error || ''}`);
        if (message.projectUrl) terminalLine('Opening the project in a new browser tab.');
      }
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'show-help') {
      showHelp();
      sendResponse({ ok: true });
      return true;
    }
    if (!SpeechRecognition) {
      updateIndicator('error');
      sendResponse({ ...getState(), error: 'Speech recognition is not supported in this browser.' });
      return true;
    }
    if (message.type === 'toggle-listening') {
      if (state.listening) stopRecognition();
      else { state.listening = true; state.sleeping = false; startRecognition(); }
    } else if (message.type === 'get-state') {
      // no-op
    }
    sendResponse(getState());
    return true;
  });
})();
