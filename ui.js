const query = new URLSearchParams(location.search);
const isTerminal = location.pathname.endsWith('/terminal.html') || query.get('view') === 'terminal';
const help = document.querySelector('#help-view');
const terminal = document.querySelector('#terminal-view');
const output = document.querySelector('#terminal-output');

if (help) help.hidden = isTerminal;
if (terminal) terminal.hidden = !isTerminal;
document.body.classList.toggle('terminal-mode', isTerminal);

function append(text) {
  if (!text) return;
  if (output.dataset.placeholder === 'true') {
    output.textContent = '';
    output.dataset.placeholder = 'false';
  }
  const line = document.createElement('div');
  line.className = 'terminal-line';
  line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  output.appendChild(line);
  output.scrollTop = output.scrollHeight;
}

if (isTerminal) {
  chrome.runtime.sendMessage({ type: 'get-ui-state' }, response => {
    for (const event of response?.terminalState || []) append(event.text || event.stdout || event.error);
  });
  chrome.runtime.onMessage.addListener(message => {
    if (message.type === 'terminal-update') {
      append(message.text || message.stdout || message.error);
      if (message.projectUrl) append(`Navigating to ${message.projectUrl}`);
    }
  });

  document.querySelector('#terminal-input')?.addEventListener('submit', event => {
    event.preventDefault();
    const input = document.querySelector('#terminal-prompt');
    const prompt = input.value.trim();
    if (!prompt) return;
    append(`> ${prompt}`);
    input.value = '';
    chrome.runtime.sendMessage({ type: 'run-codex-agent', prompt }, response => {
      if (chrome.runtime.lastError || response?.error) append(response?.error || chrome.runtime.lastError.message);
    });
  });
}

chrome.runtime.onMessage.addListener(message => {
  if (message.type !== 'scroll-ui') return;
  window.scrollBy({ top: message.direction === 'up' ? -Math.max(window.innerHeight * 0.8, 300) : Math.max(window.innerHeight * 0.8, 300), behavior: 'smooth' });
});

document.querySelector('#close-help')?.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'close-ui', view: 'help' }, () => window.close());
});
document.querySelector('#close-terminal')?.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'close-ui', view: 'terminal' }, () => window.close());
});
