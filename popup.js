const toggle = document.querySelector('#toggle');
const status = document.querySelector('#status');
const mode = document.querySelector('#mode');
const support = document.querySelector('#support');
const help = document.querySelector('#help');
const refreshLogs = document.querySelector('#refresh-logs');
const clearLogs = document.querySelector('#clear-logs');
const logs = document.querySelector('#logs');
const popupHelp = document.querySelector('#popup-help');

function render(state = {}) {
  const listening = Boolean(state.listening);
  toggle.textContent = listening ? 'Stop listening' : 'Start listening';
  toggle.classList.toggle('active', listening);
  status.textContent = state.sleeping ? 'Sleeping' : (listening ? 'Listening' : 'Off');
  mode.textContent = state.mode === 'dictation' ? 'Dictation' : 'Command';
}

async function send(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  try {
    const response = await chrome.tabs.sendMessage(tab.id, message);
    render(response);
    return response;
  } catch (error) {
    status.textContent = 'Open a normal web page first';
    return null;
  }
}

toggle.addEventListener('click', () => send({ type: 'toggle-listening' }));
help.addEventListener('click', async () => {
  popupHelp.hidden = !popupHelp.hidden;
  help.textContent = popupHelp.hidden ? 'Show command help' : 'Hide command help';
  if (!popupHelp.hidden) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) await chrome.runtime.sendMessage({ type: 'ensure-content-ui', tabId: tab.id });
  }
});
function renderLogs(items = []) {
  logs.textContent = items.length
    ? items.map(item => `${item.time} ${item.level}: ${item.message} ${JSON.stringify(item.details || {})}`).join('\n')
    : 'No logs recorded.';
}
async function loadLogs() {
  const response = await chrome.runtime.sendMessage({ type: 'get-logs' });
  renderLogs(response?.logs);
}
refreshLogs.addEventListener('click', loadLogs);
clearLogs.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clear-logs' });
  renderLogs([]);
});
support.textContent = 'Chrome speech recognition';
send({ type: 'get-state' });
