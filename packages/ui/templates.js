// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
/* Bivy UI template helpers — framework-agnostic HTML templates.
 * Keep this dependency-free so static surfaces can consume it directly.
 */
(function (global) {
  const BivyUI = {};

  BivyUI.escapeHtml = function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  };

  BivyUI.safeString = function safeString(value) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  };

  BivyUI.clip = function clip(value, max = 220) {
    const text = BivyUI.safeString(value).replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
  };

  BivyUI.compactPath = function compactPath(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    const parts = text.split('/').filter(Boolean);
    return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : text;
  };

  BivyUI.button = function button({ label, variant = 'secondary', size = '', icon = '', attrs = '' }) {
    return `<button class="btn btn-${variant}${size ? ` btn-${size}` : ''}" ${attrs}>${icon}${MeshUI.escapeHtml(label)}</button>`;
  };

  BivyUI.badge = function badge(label, tone = 'info') {
    return `<span class="badge badge-${tone}"><span class="status-dot"></span>${MeshUI.escapeHtml(label)}</span>`;
  };

  BivyUI.toolInput = function toolInput(approval) {
    return approval?.toolInput ?? approval?.input ?? approval?.args ?? approval?.arguments ?? approval?.toolCall?.arguments ?? {};
  };

  BivyUI.toolName = function toolName(approval) {
    return String(approval?.toolName || approval?.name || approval?.tool?.name || approval?.tool || approval?.toolCall?.name || 'tool').toLowerCase();
  };

  BivyUI.approvalSeverity = function approvalSeverity(approval) {
    const input = BivyUI.toolInput(approval);
    const name = BivyUI.toolName(approval);
    const text = `${name} ${Object.values(input).map(MeshUI.safeString).join(' ')}`.toLowerCase();
    if (/\b(rm\s+-rf|rm\s+-r|delete|unlink|drop\s+table|shutdown|reboot|format|wipe)\b/.test(text)) return 'critical';
    if (/\b(send|email|mail|post|publish|deploy|push|scp|curl|wget|ssh|chmod|chown|sudo)\b/.test(text)) return 'high';
    if (/\b(write|edit|mv|move|cp|copy|install|update|create)\b/.test(text)) return 'medium';
    return 'low';
  };

  BivyUI.approvalTitle = function approvalTitle(approval) {
    const input = BivyUI.toolInput(approval);
    const name = BivyUI.toolName(approval);
    const target = input.path || input.file || input.filePath || input.pathname;
    if (name.includes('bash') || name.includes('shell')) return 'Run this command?';
    if (name.includes('mail') || name.includes('email') || name.includes('send')) return 'Agent wants to send a message';
    if (name.includes('edit')) return `Edit ${MeshUI.compactPath(target) || 'a file'}?`;
    if (name.includes('write')) return `Write ${MeshUI.compactPath(target) || 'a file'}?`;
    return `Allow ${name}?`;
  };

  BivyUI.approvalIcon = function approvalIcon(approval, severity = BivyUI.approvalSeverity(approval)) {
    const name = BivyUI.toolName(approval);
    if (severity === 'critical') return '⚠';
    if (name.includes('mail') || name.includes('email') || name.includes('send')) return '✉';
    if (name.includes('bash') || name.includes('shell')) return '⌘';
    if (name.includes('write') || name.includes('edit')) return '✎';
    return '✦';
  };

  BivyUI.approvalConsequence = function approvalConsequence(approval, severity = BivyUI.approvalSeverity(approval)) {
    const input = BivyUI.toolInput(approval);
    const name = BivyUI.toolName(approval);
    const command = String(input.command || input.cmd || input.shell || '').trim();
    const target = input.path || input.file || input.filePath || input.pathname || input.cwd || input.directory;
    const recipients = input.to || input.recipients || input.recipient;
    const recipientCount = Array.isArray(recipients) ? recipients.length : recipients ? String(recipients).split(',').filter(Boolean).length : 0;
    const lower = `${name} ${command}`.toLowerCase();
    if (recipientCount || name.includes('mail') || name.includes('email') || /\b(sendmail|mail)\b/.test(lower)) {
      return recipientCount ? `This sends a message to ${recipientCount} recipient${recipientCount === 1 ? '' : 's'} immediately.` : 'This sends a message immediately.';
    }
    if (severity === 'critical') {
      return target ? `This can permanently change or delete data in ${target}. This may not be undoable.` : 'This can permanently change or delete data. This may not be undoable.';
    }
    if (/\b(curl|wget|ssh|scp|git\s+push|deploy)\b/.test(lower)) return 'This connects to an external service or publishes data outside this machine.';
    if (/\b(npm|bun|pnpm|yarn)\s+(install|add|update)\b/.test(lower)) return 'This changes project dependencies on this machine.';
    if (name.includes('write') || name.includes('edit') || /\b(write|edit|mv|cp)\b/.test(lower)) return target ? `This changes files at ${target}.` : 'This changes files in the workspace.';
    return 'The agent is paused until you approve this action.';
  };

  BivyUI.approvalFields = function approvalFields(approval) {
    const input = BivyUI.toolInput(approval);
    const name = BivyUI.toolName(approval);
    const fields = [];
    const add = (label, value) => {
      const text = String(value ?? '').trim();
      if (text) fields.push([label, text.length > 420 ? `${text.slice(0, 420)}…` : text]);
    };
    add('Tool', name);
    add('File', input.path || input.file || input.filePath || input.pathname);
    add('Command', name.includes('bash') || name.includes('shell') ? '' : input.command);
    add('Find', input.oldText || input.search || input.find);
    add('Replace', input.newText || input.replace);
    add('Text', input.content || input.text);
    return fields;
  };

  BivyUI.approvalCommand = function approvalCommand(approval) {
    const input = BivyUI.toolInput(approval);
    const name = BivyUI.toolName(approval);
    if (name.includes('bash') || name.includes('shell')) return String(input.command || input.cmd || input.shell || '').trim();
    return '';
  };

  BivyUI.approvalCard = function approvalCard(approval) {
    const severity = BivyUI.approvalSeverity(approval);
    const input = BivyUI.toolInput(approval);
    const command = BivyUI.approvalCommand(approval);
    const fields = BivyUI.approvalFields(approval);
    const raw = JSON.stringify(input, null, 2);
    const badgeTone = severity === 'critical' || severity === 'high' ? 'danger' : severity === 'medium' ? 'warn' : 'ok';
    const badgeText = severity === 'critical' ? 'Permanent' : severity === 'high' ? 'High risk' : severity === 'medium' ? 'Medium risk' : 'Low risk';
    return `
      <div class="approval-card">
        <div class="approval-who">
          <h3 class="approval-title"><span class="approval-title-icon">${MeshUI.approvalIcon(approval, severity)}</span>${MeshUI.escapeHtml(MeshUI.approvalTitle(approval))}</h3>
          ${MeshUI.badge(badgeText, badgeTone)}
        </div>
        <div class="approval-consequence">${MeshUI.escapeHtml(MeshUI.approvalConsequence(approval, severity))}</div>
        ${approval?.reason ? `<div class="approval-reason">${MeshUI.escapeHtml(approval.reason)}</div>` : ''}
        ${command ? `<pre class="approval-command">${MeshUI.escapeHtml(command)}</pre>` : ''}
        ${fields.length ? `<div class="approval-fields">${fields.map(([label, value]) => `<div class="approval-field"><div class="approval-label">${MeshUI.escapeHtml(label)}</div><div class="approval-value">${MeshUI.escapeHtml(value)}</div></div>`).join('')}</div>` : ''}
        <details class="approval-details"><summary>Show raw tool input</summary><pre>${MeshUI.escapeHtml(raw)}</pre></details>
        <div class="approval-actions"></div>
      </div>`;
  };

  BivyUI.messageRow = function messageRow({ role = 'assistant', name = 'Agent', text = '', meta = '' }) {
    const isUser = role === 'user';
    return `<div class="msg-row ${isUser ? 'user' : ''}"><span class="avatar ${isUser ? '' : 'assistant'}">${isUser ? 'You' : '✦'}</span><div class="msg-col"><div class="msg-meta">${MeshUI.escapeHtml(meta || name)}</div><div class="msg ${isUser ? 'user' : 'assistant'}">${MeshUI.escapeHtml(text)}</div></div></div>`;
  };

  global.MeshUI = BivyUI;
})(typeof window !== 'undefined' ? window : globalThis);
