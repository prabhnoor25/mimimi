import { renderMarkdown } from './markdown.js';

/* ------------------------------------------------------------------ */
/*  State                                                             */
/* ------------------------------------------------------------------ */
const state = {
  conversations: [],
  currentId: null,
  messages: [],
  isStreaming: false,
  searchQuery: '',
};

/* ------------------------------------------------------------------ */
/*  Elements                                                          */
/* ------------------------------------------------------------------ */
const els = {
  list: document.getElementById('conversationList'),
  emptyConversations: document.getElementById('emptyConversations'),
  title: document.getElementById('conversationTitle'),
  subtitle: document.getElementById('conversationSubtitle'),
  avatar: document.getElementById('convAvatar'),
  status: document.getElementById('status'),
  statusDot: document.getElementById('statusDot'),
  messages: document.getElementById('messages'),
  emptyMessages: document.getElementById('emptyMessages'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
  newChat: document.getElementById('newChat'),
  convSearch: document.getElementById('convSearch'),
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */
function api(path, opts = {}) {
  return fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  }).then(async (res) => {
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text || `HTTP ${res.status}`);
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return res.text();
  });
}

function colorForId(id) {
  const colors = [
    '#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#a855f7',
    '#06b6d4', '#84cc16', '#ec4899', '#6366f1', '#f97316',
  ];
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

function avatarChar(title) {
  return (title || 'New chat')[0].toUpperCase();
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

function dayKey(ts) {
  return new Date(ts).toDateString();
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function setStatus(text, kind = 'idle') {
  els.status.textContent = text;
  els.statusDot.className = 'status-dot ' + kind;
}

function scrollBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

/* ------------------------------------------------------------------ */
/*  Auto-resizing textarea                                            */
/* ------------------------------------------------------------------ */
function initAutosize() {
  const ta = els.input;
  const adjust = () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
  };
  ta.addEventListener('input', adjust);
  adjust();
}

/* ------------------------------------------------------------------ */
/*  Conversations                                                     */
/* ------------------------------------------------------------------ */
async function loadConversations() {
  try {
    state.conversations = await api('/api/conversations');
  } catch (err) {
    console.error('Failed to load conversations:', err);
    state.conversations = [];
  }
  renderList();
  if (!state.currentId && state.conversations.length) {
    selectConversation(state.conversations[0].id);
  } else if (!state.currentId) {
    renderEmptyMessages();
  }
}

function renderList() {
  const query = state.searchQuery.toLowerCase();
  const filtered = state.conversations.filter((c) => {
    if (!query) return true;
    return (c.title || '').toLowerCase().includes(query);
  });

  els.list.innerHTML = '';
  els.emptyConversations.style.display = filtered.length ? 'none' : 'block';

  for (const c of filtered) {
    const li = document.createElement('li');
    li.className = c.id === state.currentId ? 'selected' : '';
    li.innerHTML = `
      <div class="conv-title">${escapeHtml(c.title || 'New chat')}</div>
      <div class="conv-meta">${formatTime(c.updated_at)}</div>
    `;
    li.style.borderLeft = `3px solid ${colorForId(c.id)}`;
    li.onclick = () => selectConversation(c.id);
    els.list.appendChild(li);
  }
}

async function selectConversation(id) {
  state.currentId = id;
  state.isStreaming = false;
  renderList();
  const conv = state.conversations.find((c) => c.id === id);
  if (conv) {
    els.title.textContent = conv.title || 'New chat';
    els.subtitle.textContent = formatDate(conv.updated_at);
    els.avatar.textContent = avatarChar(conv.title);
    els.avatar.style.background = colorForId(conv.id);
  } else {
    els.title.textContent = 'New chat';
    els.subtitle.textContent = '';
    els.avatar.textContent = '?';
    els.avatar.style.background = '';
  }
  els.status.textContent = 'Idle';
  els.statusDot.className = 'status-dot idle';

  try {
    const messages = await api(`/api/conversations/${id}/messages`);
    state.messages = messages;
    renderMessages();
  } catch (err) {
    console.error('Failed to load messages:', err);
    state.messages = [];
    renderEmptyMessages();
  }
  scrollBottom();
}

async function newConversation() {
  try {
    const c = await api('/api/conversations', { method: 'POST' });
    state.conversations.unshift(c);
    renderList();
    selectConversation(c.id);
    els.input.focus();
  } catch (err) {
    console.error('Failed to create conversation:', err);
    setStatus('Error', 'error');
  }
}

/* ------------------------------------------------------------------ */
/*  Messages                                                          */
/* ------------------------------------------------------------------ */
function renderEmptyMessages() {
  els.emptyMessages.style.display = state.messages.length ? 'none' : 'flex';
}

function renderMessages() {
  els.messages.innerHTML = '';
  let lastDay = null;
  for (const m of state.messages) {
    const day = dayKey(m.created_at);
    if (day !== lastDay) {
      lastDay = day;
      const sep = document.createElement('div');
      sep.className = 'date-sep';
      sep.textContent = formatDate(m.created_at);
      els.messages.appendChild(sep);
    }
    els.messages.appendChild(messageElement(m));
  }
  renderEmptyMessages();
  scrollBottom();
}

function messageElement(m) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${m.role}`;
  wrap.style.animation = 'slideIn 0.3s ease';

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = formatTime(m.created_at);

  if (m.role === 'user') {
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = m.content;
    wrap.appendChild(bubble);
  } else {
    // Tool call chips
    if (m.tool_calls) {
      try {
        const calls = JSON.parse(m.tool_calls);
        for (const c of calls) {
          const chip = document.createElement('div');
          chip.className = 'tool-chip';
          chip.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"></circle><path d="M12 1v8M12 21v-8M4 12h8M21 12h-8"></path>
            </svg>
            ${escapeHtml(c.function.name)}
          `;
          wrap.appendChild(chip);
        }
      } catch (_) { /* ignore */ }
    }

    const bubble = document.createElement('div');
    bubble.className = 'bubble msg-assist-content';
    bubble.innerHTML = renderMarkdown(m.content || '');
    wrap.appendChild(bubble);
  }
  wrap.appendChild(meta);
  return wrap;
}

/* ------------------------------------------------------------------ */
/*  Streaming                                                         */
/* ------------------------------------------------------------------ */
let currentBubble = null;
let currentWrap = null;
let pendingHtml = '';
let typingInterval = null;

function startTyping() {
  if (typingInterval) return;
  const dots = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
  currentWrap = document.createElement('div');
  currentWrap.className = 'msg assistant';
  currentWrap.style.animation = 'slideIn 0.3s ease';

  const chipWrap = document.createElement('div');
  currentWrap.appendChild(chipWrap);

  currentBubble = document.createElement('div');
  currentBubble.className = 'bubble msg-assist-content';
  currentWrap.appendChild(currentBubble);

  const typing = document.createElement('div');
  typing.className = 'typing-indicator';
  typing.innerHTML = dots;
  currentWrap.appendChild(typing);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = formatTime(Date.now());
  currentWrap.appendChild(meta);

  els.messages.appendChild(currentWrap);
  renderEmptyMessages();
  scrollBottom();
}

function stopTyping() {
  if (typingInterval) {
    clearInterval(typingInterval);
    typingInterval = null;
  }
  if (currentWrap) {
    const typing = currentWrap.querySelector('.typing-indicator');
    if (typing) typing.remove();
  }
}

function appendAssistantChunk(html) {
  stopTyping();
  if (!currentBubble) startTyping();
  currentBubble.innerHTML = renderMarkdown(html);
  scrollBottom();
}

function addToolChip(label) {
  stopTyping();
  if (!currentWrap) startTyping();
  const chip = document.createElement('div');
  chip.className = 'tool-chip';
  chip.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="3"></circle><path d="M12 1v8M12 21v-8M4 12h8M21 12h-8"></path>
    </svg>
    ${escapeHtml(label)}
  `;
  currentWrap.insertBefore(chip, currentBubble);
  scrollBottom();
}

/* ------------------------------------------------------------------ */
/*  Send message                                                      */
/* ------------------------------------------------------------------ */
async function sendMessage() {
  if (state.isStreaming) return;
  const text = els.input.value.trim();
  if (!text) return;

  // Defensive: ensure we have a conversation
  if (!state.currentId && state.conversations.length) {
    state.currentId = state.conversations[0].id;
  }

  els.input.value = '';
  els.input.style.height = 'auto';
  els.send.disabled = true;
  state.isStreaming = true;
  setStatus('Thinking…', 'thinking');

  // Optimistic user message
  const userMsg = { role: 'user', content: text, created_at: Date.now() };
  state.messages.push(userMsg);
  els.messages.appendChild(messageElement(userMsg));
  renderEmptyMessages();
  scrollBottom();

  currentBubble = null;
  currentWrap = null;
  pendingHtml = '';

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: state.currentId, message: text }),
    });

    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop(); // incomplete tail stays buffered

      for (const part of parts) {
        if (!part.trim()) continue;
        const lines = part.split('\n');
        const eventLine = lines.find((l) => l.startsWith('event: '));
        const dataLine = lines.find((l) => l.startsWith('data: '));
        const eventType = eventLine ? eventLine.slice(7) : null;
        const payload = dataLine ? JSON.parse(dataLine.slice(6)) : {};

        if (eventType === 'conversation') {
          if (payload.id && payload.id !== state.currentId) {
            state.currentId = payload.id;
            renderList();
          }
          if (payload.title) {
            els.title.textContent = payload.title;
            els.avatar.textContent = avatarChar(payload.title);
            els.avatar.style.background = colorForId(state.currentId);
          }
        } else if (eventType === 'text_chunk') {
          pendingHtml += payload.delta || '';
          appendAssistantChunk(pendingHtml);
        } else if (eventType === 'tool_result') {
          const name = payload.call?.function?.name || 'tool';
          let label = name;
          if (!payload.result || payload.result.unavailable) label += ' (search unavailable)';
          else if (payload.result.error) label += ' — error';
          else if (payload.result.results) label += ` — ${payload.result.results.length} results`;
          addToolChip(label);
        } else if (eventType === 'error') {
          setStatus('Error', 'error');
          if (currentBubble) {
            currentBubble.textContent = `Error: ${escapeHtml(payload.message || 'Unknown error')}`;
            currentBubble.style.color = 'var(--danger)';
          }
        } else if (eventType === 'done') {
          setStatus('Idle', 'idle');
        }
      }
    }
  } catch (err) {
    console.error('Chat error:', err);
    setStatus('Error', 'error');
    if (currentBubble) {
      currentBubble.textContent = `Error: ${escapeHtml(err.message || 'Unexpected error')}`;
      currentBubble.style.color = 'var(--danger)';
    } else {
      // Show error inline if no bubble was created
      const wrap = document.createElement('div');
      wrap.className = 'msg assistant';
      const bubble = document.createElement('div');
      bubble.className = 'bubble msg-assist-content';
      bubble.textContent = `Error: ${escapeHtml(err.message || 'Unexpected error')}`;
      bubble.style.color = 'var(--danger)';
      wrap.appendChild(bubble);
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = formatTime(Date.now());
      wrap.appendChild(meta);
      els.messages.appendChild(wrap);
      renderEmptyMessages();
      scrollBottom();
    }
  } finally {
    state.isStreaming = false;
    stopTyping();
    els.send.disabled = false;
    els.input.disabled = false;
    els.input.focus();
  }
}

/* ------------------------------------------------------------------ */
/*  Event listeners                                                   */
/* ------------------------------------------------------------------ */
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

els.send.addEventListener('click', sendMessage);
els.newChat.addEventListener('click', newConversation);

els.convSearch.addEventListener('input', (e) => {
  state.searchQuery = e.target.value;
  renderList();
});

initAutosize();
loadConversations();
