/** Small, safe markdown-ish renderer for assistant messages. No external deps. */
export function renderMarkdown(text) {
  if (!text) return '';
  // Escape HTML first so nothing in user/model text can inject markup.
  let html = escapeHtml(text);

  // Fenced code blocks (content is already escaped above).
  html = html.replace(/```([\s\S]*?)```/g, (_m, code) => {
    return `<pre><code>${code.trim()}</code></pre>`;
  });

  // Headings.
  html = html.replace(/^#{1,6}\s+(.*)$/gm, (_m, c) => `<h3>${c}</h3>`);

  // Bold, then italic.
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Inline code.
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Links.
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );

  // Paragraphs and line breaks.
  html = html.replace(/\n\n+/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  return `<p>${html}</p>`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
