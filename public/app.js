const term = new window.Terminal({
  cursorBlink: false,
  convertEol: true,
  customGlyphs: false,
  fontSize: 14,
  fontFamily: '"Cascadia Mono", Consolas, monospace',
  scrollback: 5000,
  smoothScrollDuration: 0,
  theme: {
    background: "#111318",
    foreground: "#f3f4f6",
    selectionBackground: "#3b82f655",
    selectionInactiveBackground: "#3b82f633"
  }
});

const fitAddon = new window.FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById("terminal"));
fitAddon.fit();

const tokenInput = document.getElementById("token");
const cwdInput = document.getElementById("cwd");
const nameInput = document.getElementById("session-name");
const connectButton = document.getElementById("connect");
const newSessionButton = document.getElementById("new-session");
const refreshButton = document.getElementById("refresh");
const closeSessionButton = document.getElementById("close-session");
const browseUpButton = document.getElementById("browse-up");
const syncBrowserPathButton = document.getElementById("sync-browser-path");
const sessionsRoot = document.getElementById("sessions");
const sessionLiveCountRoot = document.getElementById("session-live-count");
const sessionSavedCountRoot = document.getElementById("session-saved-count");
const sessionTotalCountRoot = document.getElementById("session-total-count");
const homeStatusRoot = document.getElementById("home-status");
const browserCurrentRoot = document.getElementById("browser-current");
const directoryTreeRoot = document.getElementById("directory-tree");
const activeSessionNameRoot = document.getElementById("active-session-name");
const activeSessionMetaRoot = document.getElementById("active-session-meta");
const viewConnect = document.getElementById("view-connect");
const viewWorkspace = document.getElementById("view-workspace");
const workspaceHome = document.getElementById("workspace-home");
const workspaceTerminal = document.getElementById("workspace-terminal");
const terminalTopbar = workspaceTerminal?.querySelector(".terminal-topbar");
const sessionPanel = document.getElementById("session-panel");
const panelBackdrop = document.getElementById("panel-backdrop");
const openPanelButton = document.getElementById("open-panel");
const closePanelButton = document.getElementById("close-panel");
const backToConnectButton = document.getElementById("back-to-connect");
const backToSessionsButton = document.getElementById("back-to-sessions");
const terminalRoot = document.getElementById("terminal");
const mobileComposer = document.getElementById("mobile-composer");
const imeBridge = document.getElementById("ime-bridge");
const composerEscButton = document.getElementById("composer-esc");
const composerSendButton = document.getElementById("composer-send");
const escKeyButton = document.getElementById("esc-key");
const copyTerminalButton = document.getElementById("copy-terminal");
const pasteTerminalButton = document.getElementById("paste-terminal");
const clipboardSheet = document.getElementById("clipboard-sheet");
const clipboardTitle = document.getElementById("clipboard-title");
const clipboardHint = document.getElementById("clipboard-hint");
const clipboardBuffer = document.getElementById("clipboard-buffer");
const clipboardPrimaryButton = document.getElementById("clipboard-primary");
const clipboardCloseButton = document.getElementById("clipboard-close");

let accessToken = "";
let activeSessionId = "";
let activeSession = null;
let socket = null;
let sessions = [];
let reconnectTimer = null;
let isManualDisconnect = false;
let isAuthenticated = false;
let pendingOutput = "";
let outputFrame = null;
let viewportFrame = null;
let keyboardWasOpen = false;
let imeComposing = false;
let clipboardMode = "";
let latestStatus = "Disconnected";
let mobileComposerValue = "";
let browserState = {
  path: "",
  parentPath: "",
  entries: [],
  totalEntries: 0,
  truncated: false
};

const useImeBridge = window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
const enableMobileComposer = false;
document.documentElement.classList.toggle("touch-input-mode", useImeBridge);
document.documentElement.classList.toggle("mobile-composer-disabled", !enableMobileComposer);
const melbourneFormatter = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Melbourne",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

function clearReconnectTimer() {
  if (reconnectTimer) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function normalizeTextForTerminalPaste(value) {
  return String(value || "").replace(/\r?\n/g, "\r");
}

function readTerminalBufferText() {
  const buffer = term.buffer.active;
  const lines = [];
  let currentLine = "";
  let hasLine = false;

  for (let index = 0; index < buffer.length; index += 1) {
    const line = buffer.getLine(index);
    if (!line) {
      continue;
    }

    const text = line.translateToString(true);
    if (!hasLine) {
      currentLine = text;
      hasLine = true;
      continue;
    }

    if (line.isWrapped) {
      currentLine += text;
      continue;
    }

    lines.push(currentLine);
    currentLine = text;
  }

  if (hasLine) {
    lines.push(currentLine);
  }

  return lines.join("\n");
}

function closeClipboardSheet({ restoreFocus = true } = {}) {
  clipboardMode = "";
  clipboardSheet.classList.add("hidden");
  clipboardSheet.setAttribute("aria-hidden", "true");
  clipboardBuffer.value = "";
  clipboardBuffer.readOnly = false;

  if (!restoreFocus) {
    return;
  }

  if (useImeBridge) {
    focusImeBridge();
    return;
  }

  term.focus();
}

function openClipboardSheet(mode) {
  clipboardMode = mode;
  blurImeBridge();
  clipboardSheet.classList.remove("hidden");
  clipboardSheet.setAttribute("aria-hidden", "false");

  if (mode === "copy") {
    const text = readTerminalBufferText();
    if (!text.trim()) {
      closeClipboardSheet({ restoreFocus: false });
      setStatus("No terminal output available to copy.");
      return;
    }

    clipboardTitle.textContent = "Copy Terminal Text";
    clipboardHint.textContent = "Long-press below to select any part of the terminal output.";
    clipboardPrimaryButton.textContent = "Copy All";
    clipboardBuffer.readOnly = true;
    clipboardBuffer.value = text;
  } else {
    clipboardTitle.textContent = "Paste Into Terminal";
    clipboardHint.textContent = "Long-press inside the box, paste text, then send it to the terminal.";
    clipboardPrimaryButton.textContent = "Send to Terminal";
    clipboardBuffer.readOnly = false;
    clipboardBuffer.value = "";
  }

  window.requestAnimationFrame(() => {
    clipboardBuffer.focus({ preventScroll: true });
    const length = clipboardBuffer.value.length;
    clipboardBuffer.setSelectionRange(length, length);
    if (mode === "copy") {
      clipboardBuffer.scrollTop = clipboardBuffer.scrollHeight;
    }
  });
}

async function handleClipboardPrimaryAction() {
  if (clipboardMode === "copy") {
    clipboardBuffer.focus({ preventScroll: true });
    clipboardBuffer.select();
    try {
      if (window.isSecureContext && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(clipboardBuffer.value);
        setStatus("Terminal text copied.");
      } else {
        setStatus("Text selected. Use your browser copy action.");
      }
    } catch {
      setStatus("Text selected. Use your browser copy action.");
    }
    return;
  }

  const text = clipboardBuffer.value;
  if (!text) {
    setStatus("Paste text into the box first.");
    return;
  }

  sendToSession(normalizeTextForTerminalPaste(text));
  closeClipboardSheet();
  scrollTerminalToLatest();
  setStatus("Clipboard text sent to terminal.");
}

function flushPendingOutput() {
  outputFrame = null;
  if (!pendingOutput) {
    return;
  }

  term.write(pendingOutput);
  pendingOutput = "";
  if (keyboardWasOpen) {
    scrollTerminalToLatest();
  }
}

function queueTerminalOutput(chunk) {
  if (!chunk) {
    return;
  }

  pendingOutput += chunk;
  if (outputFrame === null) {
    outputFrame = window.requestAnimationFrame(flushPendingOutput);
  }
}

function scrollTerminalToLatest({ ensureVisible = false } = {}) {
  window.requestAnimationFrame(() => {
    if (ensureVisible) {
      terminalRoot.scrollIntoView({
        block: "end",
        inline: "nearest"
      });
    }

    term.scrollToBottom?.();
    const viewport = terminalRoot.querySelector(".xterm-viewport");
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  });
}

function lockRootScrollPosition() {
  if (!useImeBridge || !document.documentElement.classList.contains("terminal-layer-mode")) {
    return;
  }

  const scrollingRoot = document.scrollingElement;
  if (scrollingRoot) {
    scrollingRoot.scrollTop = 0;
    scrollingRoot.scrollLeft = 0;
  }
  window.scrollTo(0, 0);
}

function deferRootScrollLock() {
  if (!useImeBridge || !document.documentElement.classList.contains("terminal-layer-mode")) {
    return;
  }

  window.requestAnimationFrame(() => {
    lockRootScrollPosition();
  });
}

function setComposerExpanded(expanded) {
  if (!enableMobileComposer) {
    workspaceTerminal.classList.remove("composer-active");
    return;
  }
  workspaceTerminal.classList.toggle("composer-active", Boolean(expanded));
}

function syncTerminalChromeBounds() {
  if (!workspaceTerminal) {
    return;
  }

  if (!useImeBridge || !document.documentElement.classList.contains("terminal-layer-mode")) {
    workspaceTerminal.style.removeProperty("--terminal-header-height");
    workspaceTerminal.style.removeProperty("--terminal-composer-height");
    return;
  }

  const headerHeight = Math.ceil(terminalTopbar?.getBoundingClientRect().height || 0);
  const composerHeight = enableMobileComposer
    ? Math.ceil(mobileComposer?.getBoundingClientRect().height || 0)
    : 0;
  const headerOffset = headerHeight > 0 ? headerHeight + 6 : 0;
  const composerOffset = composerHeight > 0 ? composerHeight + 6 : 0;
  workspaceTerminal.style.setProperty("--terminal-header-height", `${headerOffset}px`);
  workspaceTerminal.style.setProperty("--terminal-composer-height", `${composerOffset}px`);

  if (!workspaceTerminal.classList.contains("hidden")) {
    window.requestAnimationFrame(() => {
      syncTerminalSize();
    });
  }
}

function syncComposerLayout() {
  if (!useImeBridge || !enableMobileComposer) {
    return;
  }

  imeBridge.style.height = "0px";
  const minHeight = workspaceTerminal.classList.contains("composer-active") ? 84 : 44;
  const nextHeight = Math.min(140, Math.max(minHeight, imeBridge.scrollHeight || 0));
  imeBridge.style.height = `${nextHeight}px`;
  syncTerminalChromeBounds();
}

function resetImeBridge() {
  imeBridge.value = "";
  mobileComposerValue = "";
  imeComposing = false;
  syncComposerLayout();
}

function focusImeBridge() {
  if (!useImeBridge || !hasLiveSession()) {
    return;
  }

  setComposerExpanded(true);
  imeBridge.focus({ preventScroll: true });
  const length = imeBridge.value.length;
  imeBridge.setSelectionRange(length, length);
  syncComposerLayout();
}

function blurImeBridge() {
  if (!useImeBridge) {
    return;
  }

  imeBridge.blur();
  if (!imeBridge.value) {
    setComposerExpanded(false);
  }
}

function syncImeBridgeValue() {
  if (imeComposing) {
    return;
  }

  const nextValue = String(imeBridge.value || "").replace(/\r/g, "");
  if (imeBridge.value !== nextValue) {
    imeBridge.value = nextValue;
  }

  if (nextValue === mobileComposerValue) {
    syncComposerLayout();
    return;
  }

  if (nextValue.startsWith(mobileComposerValue)) {
    sendToSession(nextValue.slice(mobileComposerValue.length));
  } else if (mobileComposerValue.startsWith(nextValue)) {
    sendToSession("\u007f".repeat(mobileComposerValue.length - nextValue.length));
  } else {
    if (mobileComposerValue.length) {
      sendToSession("\u007f".repeat(mobileComposerValue.length));
    }
    if (nextValue) {
      sendToSession(nextValue);
    }
  }

  mobileComposerValue = nextValue;
  syncComposerLayout();
  scrollTerminalToLatest();
}

function submitImeBridge() {
  if (!hasLiveSession()) {
    setStatus("Open a session first.");
    return;
  }

  syncImeBridgeValue();
  sendToSession("\r");
  resetImeBridge();
  blurImeBridge();
  requestViewportMetrics();
  scrollTerminalToLatest();
}

function flushImeBridgeValue() {
  syncImeBridgeValue();
}

function applyViewportMetrics() {
  viewportFrame = null;
  const viewport = window.visualViewport;
  const viewportHeight = Math.round(viewport?.height || window.innerHeight);
  const keyboardInset = Math.max(0, window.innerHeight - viewportHeight);
  const keyboardOpen = keyboardInset > 120;
  document.documentElement.style.setProperty("--vvh", `${viewportHeight}px`);
  document.documentElement.style.setProperty("--keyboard-inset", `${keyboardInset}px`);
  document.documentElement.classList.toggle("keyboard-open", keyboardOpen);
  if (keyboardOpen) {
    deferRootScrollLock();
  }
  if (useImeBridge) {
    if (keyboardOpen) {
      setComposerExpanded(true);
    } else if (!imeBridge.matches(":focus") && !imeBridge.value) {
      setComposerExpanded(false);
    }
    syncComposerLayout();
  }
  syncTerminalSize();
  if (keyboardOpen) {
    scrollTerminalToLatest();
  }
  keyboardWasOpen = keyboardOpen;
}

function requestViewportMetrics() {
  if (viewportFrame !== null) {
    return;
  }

  viewportFrame = window.requestAnimationFrame(applyViewportMetrics);
}

function hasLiveSession() {
  return Boolean(socket && socket.readyState === WebSocket.OPEN && activeSessionId);
}

function setView(name) {
  const workspace = name === "workspace";
  viewConnect.classList.toggle("hidden", workspace);
  viewWorkspace.classList.toggle("hidden", !workspace);
}

function setWorkspaceScreen(name) {
  const terminal = name === "terminal";
  workspaceHome.classList.toggle("hidden", terminal);
  workspaceTerminal.classList.toggle("hidden", !terminal);
  document.documentElement.classList.toggle("terminal-layer-mode", terminal && useImeBridge);
  if (!terminal) {
    setComposerExpanded(false);
  }
  deferRootScrollLock();
  syncTerminalChromeBounds();
  syncComposerLayout();
}

function setPanelOpen(open) {
  sessionPanel.classList.toggle("open", open);
  panelBackdrop.classList.toggle("hidden", !open);
  sessionPanel.setAttribute("aria-hidden", String(!open));
  document.body.classList.toggle("panel-open", open);
}

function updateInputControls() {
  const enabled = hasLiveSession();
  escKeyButton.disabled = !enabled;
  imeBridge.disabled = !enabled;
  composerEscButton.disabled = !enabled || !enableMobileComposer;
  composerSendButton.disabled = !enabled || !enableMobileComposer;
  copyTerminalButton.disabled = !activeSessionId;
  pasteTerminalButton.disabled = !enabled;
  closeSessionButton.disabled = !activeSessionId;

  if (!enabled) {
    resetImeBridge();
    blurImeBridge();
    setComposerExpanded(false);
    clearReconnectTimer();
  }
}

function setStatus(text) {
  latestStatus = String(text || "").trim() || "Disconnected";
  if (homeStatusRoot) {
    homeStatusRoot.textContent = latestStatus;
  }
  updateWorkspaceSummary();
}

function headers() {
  return {
    "Content-Type": "application/json"
  };
}

function formatTime(value) {
  try {
    return `${melbourneFormatter.format(new Date(value))} AEDT`;
  } catch {
    return value || "";
  }
}

function humanFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 102.4) / 10} KB`;
  }
  return `${Math.round(bytes / 104857.6) / 10} MB`;
}

async function copyText(text, fallbackStatus) {
  const value = String(text || "");
  if (!value) {
    return false;
  }

  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fallback to selection-based copy below.
  }

  clipboardTitle.textContent = "Copy Path";
  clipboardHint.textContent = "Select the path below and use your browser copy action.";
  clipboardPrimaryButton.textContent = "Select All";
  clipboardMode = "copy";
  clipboardSheet.classList.remove("hidden");
  clipboardSheet.setAttribute("aria-hidden", "false");
  clipboardBuffer.readOnly = true;
  clipboardBuffer.value = value;

  window.requestAnimationFrame(() => {
    clipboardBuffer.focus({ preventScroll: true });
    clipboardBuffer.select();
  });

  if (fallbackStatus) {
    setStatus(fallbackStatus);
  }
  return false;
}

function updateWorkspaceSummaryLegacy() {
  return;

  if (activeSession) {
    const parts = [activeSession.status || "unknown"];
    if (activeSession.cwd) {
      parts.push(activeSession.cwd);
    }
    activeSessionMetaRoot.textContent = parts.join(" · ");
  } else {
    activeSessionMetaRoot.textContent = "Connect, then open a session.";
  }

  browserPillRoot.textContent = browserState.path || "Not loaded";
}

function updateWorkspaceSummary() {
  activeSessionNameRoot.textContent = activeSession?.name || "No active session";

  if (activeSession) {
    const parts = [];
    if (latestStatus) {
      parts.push(latestStatus);
    }
    if (activeSession.status && activeSession.status !== latestStatus) {
      parts.push(activeSession.status);
    }
    if (activeSession.cwd) {
      parts.push(activeSession.cwd);
    }
    activeSessionMetaRoot.textContent = parts.join(" | ");
    return;
  }

  activeSessionMetaRoot.textContent = "Open a session to start.";
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    credentials: "same-origin",
    headers: {
      ...(options.headers || {}),
      ...headers()
    }
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    if (response.status === 401) {
      isAuthenticated = false;
    }
    throw new Error(payload.error || response.statusText);
  }

  return response.json();
}

async function loginWithToken(token) {
  await request("/api/login", {
    method: "POST",
    body: JSON.stringify({ token })
  });
  isAuthenticated = true;
}

async function logoutSession() {
  try {
    await request("/api/logout", { method: "POST" });
  } catch {
    // Ignore logout failures during local UI reset.
  }
  isAuthenticated = false;
}

function buildSectionLabel(text) {
  const label = document.createElement("div");
  label.className = "session-section-label";
  label.textContent = text;
  return label;
}

function buildEmptyState(title, description) {
  const empty = document.createElement("div");
  empty.className = "session-empty";

  const heading = document.createElement("h3");
  heading.textContent = title;
  empty.appendChild(heading);

  const body = document.createElement("p");
  body.textContent = description;
  empty.appendChild(body);
  return empty;
}

function renderSessions() {
  sessionsRoot.innerHTML = "";
  const liveSessions = sessions.filter((session) => session.kind === "live");
  const savedSessions = sessions.filter((session) => session.kind === "history");

  sessionLiveCountRoot.textContent = String(liveSessions.length);
  sessionSavedCountRoot.textContent = String(savedSessions.length);
  sessionTotalCountRoot.textContent = String(sessions.length);

  if (!sessions.length) {
    sessionsRoot.appendChild(
      buildEmptyState(
        "No sessions yet",
        "Create a new session here. If the name is blank, the first prompt will become the title."
      )
    );
    return;
  }

  if (liveSessions.length) {
    sessionsRoot.appendChild(buildSectionLabel("Live in browser"));
    for (const session of liveSessions) {
      sessionsRoot.appendChild(buildSessionCard(session));
    }
  }

  if (savedSessions.length) {
    sessionsRoot.appendChild(buildSectionLabel("Saved Codex sessions"));
    for (const session of savedSessions) {
      sessionsRoot.appendChild(buildSessionCard(session));
    }
  }
}

function buildBadge(text, extraClass = "") {
  const badge = document.createElement("span");
  badge.className = `session-badge${extraClass ? ` ${extraClass}` : ""}`;
  badge.textContent = text;
  return badge;
}

function buildSessionCard(session) {
  const card = document.createElement("button");
  const isCurrent = session.kind === "live" && session.id === activeSessionId;
  card.className = `session-card${isCurrent ? " active" : ""}`;

  const head = document.createElement("div");
  head.className = "session-card-head";

  const title = document.createElement("h3");
  title.textContent = session.name;
  head.appendChild(title);

  const badgeRow = document.createElement("div");
  badgeRow.className = "session-badge-row";
  if (isCurrent) {
    badgeRow.appendChild(buildBadge("Current"));
  }
  if (session.kind === "history") {
    badgeRow.appendChild(buildBadge("Saved", "ghost-badge"));
  }
  head.appendChild(badgeRow);
  card.appendChild(head);

  const preview = document.createElement("p");
  preview.className = `session-preview${session.inputPreview ? "" : " muted"}`;
  preview.textContent = session.inputPreview || "No prompt preview available";
  card.appendChild(preview);

  const metaGrid = document.createElement("div");
  metaGrid.className = "session-meta-grid";
  metaGrid.appendChild(buildSessionMeta("Status", session.status));
  metaGrid.appendChild(buildSessionMeta("Folder", session.cwd));
  metaGrid.appendChild(buildSessionMeta("Updated", formatTime(session.updatedAt)));
  card.appendChild(metaGrid);

  card.addEventListener("click", () => activateSessionFromList(session));
  return card;
}

function buildSessionMeta(label, value) {
  const item = document.createElement("p");
  item.className = "session-meta-line";

  const caption = document.createElement("span");
  caption.className = "session-meta-label";
  caption.textContent = `${label}: `;
  item.appendChild(caption);

  const body = document.createElement("span");
  body.className = "session-meta-value";
  body.textContent = value || "—";
  item.appendChild(body);

  return item;
}

async function activateSessionFromList(session) {
  if (session.kind === "history") {
    try {
      const payload = await request("/api/sessions", {
        method: "POST",
        body: JSON.stringify({
          cwd: session.cwd,
          name: session.name,
          resumeSessionId: session.resumeSessionId
        })
      });
      await refreshSessions();
      await openSession(payload.session.id);
      await loadDirectory(session.cwd);
    } catch (err) {
      setStatus(err.message || String(err));
    }
    return;
  }

  await openSession(session.id);
  await loadDirectory(session.cwd);
}

async function refreshSessions() {
  const payload = await request("/api/sessions");
  sessions = payload.sessions || [];
  activeSession = sessions.find((session) => session.id === activeSessionId) || activeSession;
  if (activeSessionId && !sessions.some((session) => session.id === activeSessionId)) {
    activeSession = null;
    activeSessionId = "";
  }
  renderSessions();
  updateWorkspaceSummary();
  updateInputControls();
}

function syncTerminalSize() {
  fitAddon.fit();
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(
      JSON.stringify({
        type: "resize",
        cols: term.cols,
        rows: term.rows
      })
    );
  }
}

function disconnectSocket() {
  clearReconnectTimer();
  if (socket) {
    const currentSocket = socket;
    socket = null;
    currentSocket.close();
  }
  updateInputControls();
}

function scheduleReconnect() {
  if (!activeSessionId || !isAuthenticated || document.hidden || reconnectTimer || hasLiveSession()) {
    return;
  }

  reconnectTimer = window.setTimeout(async () => {
    reconnectTimer = null;
    if (!activeSessionId || !isAuthenticated || document.hidden || hasLiveSession()) {
      return;
    }

    try {
      await connectToSession(activeSessionId, { resetTerminal: true, allowReconnect: true });
    } catch (err) {
      setStatus(err.message || String(err));
      scheduleReconnect();
    }
  }, 600);
}

async function connectToSession(sessionId, { resetTerminal = true, allowReconnect = false } = {}) {
  clearReconnectTimer();
  if (socket) {
    const currentSocket = socket;
    socket = null;
    currentSocket.close();
  }

  activeSessionId = sessionId;
  activeSession = sessions.find((session) => session.id === sessionId) || activeSession;
  renderSessions();
  updateWorkspaceSummary();
  setWorkspaceScreen("terminal");
  setPanelOpen(false);

  if (resetTerminal) {
    pendingOutput = "";
    if (outputFrame !== null) {
      window.cancelAnimationFrame(outputFrame);
      outputFrame = null;
    }
    term.reset();
  }

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(
    `${protocol}://${window.location.host}/ws?sessionId=${encodeURIComponent(sessionId)}`
  );
  socket = ws;

  ws.addEventListener("open", async () => {
    setStatus("connected");
    syncTerminalSize();
    if (!useImeBridge) {
      term.focus();
    }
    updateInputControls();
    await refreshSessions();
  });

  ws.addEventListener("message", async (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "snapshot") {
      activeSession = payload.session || activeSession;
      updateWorkspaceSummary();
      queueTerminalOutput(payload.buffer || "");
      setStatus(payload.session.status || "running");
      return;
    }
    if (payload.type === "data") {
      queueTerminalOutput(payload.data || "");
      return;
    }
    if (payload.type === "exit") {
      setStatus(`exited ${payload.exitCode}`);
      await refreshSessions();
      return;
    }
    if (payload.type === "error") {
      setStatus(payload.error || "Session error");
    }
  });

  ws.addEventListener("close", () => {
    if (socket === ws) {
      socket = null;
    }
    setStatus("disconnected");
    updateInputControls();
    if (!isManualDisconnect && allowReconnect) {
      scheduleReconnect();
    }
  });

  ws.addEventListener("error", () => {
    if (!isManualDisconnect && allowReconnect) {
      scheduleReconnect();
    }
  });
}

async function openSession(sessionId) {
  isManualDisconnect = false;
  await connectToSession(sessionId, { resetTerminal: true, allowReconnect: true });
  await loadDirectory(activeSession?.cwd || "");
}

function sendToSession(data) {
  if (!hasLiveSession()) {
    setStatus("Open a session first.");
    return;
  }

  socket.send(JSON.stringify({ type: "input", data }));
}

function buildDirectoryEntry(entry) {
  const item = document.createElement("button");
  item.className = `directory-entry ${entry.type}`;

  const icon = document.createElement("span");
  icon.className = "directory-icon";
  icon.textContent = entry.type === "directory" ? "DIR" : "FILE";
  item.appendChild(icon);

  const copy = document.createElement("div");
  copy.className = "directory-copy";

  const name = document.createElement("strong");
  name.textContent = entry.name;
  copy.appendChild(name);

  const meta = document.createElement("span");
  if (entry.type === "directory") {
    meta.textContent = entry.path;
  } else {
    const sizeText = humanFileSize(entry.size);
    meta.textContent = sizeText ? `${sizeText} · ${entry.path}` : entry.path;
  }
  copy.appendChild(meta);
  item.appendChild(copy);
  item.innerHTML = "";
  item.textContent = entry.type === "directory" ? `${entry.name}\\` : entry.name;

  item.addEventListener("click", async () => {
    if (entry.type === "directory") {
      await loadDirectory(entry.path);
      return;
    }

    const copied = await copyText(entry.path, "Path selected. Use your browser copy action.");
    if (copied) {
      setStatus(`Copied ${entry.path}`);
      return;
    }
    setStatus(entry.path);
  });

  return item;
}

function renderDirectoryBrowser() {
  directoryTreeRoot.innerHTML = "";

  if (!browserState.path) {
    directoryTreeRoot.appendChild(
      buildEmptyState("No folder loaded", "Open a session first, then use the menu to browse files.")
    );
    updateWorkspaceSummary();
    return;
  }

  const summary = document.createElement("div");
  summary.className = "directory-summary";
  summary.textContent = browserState.truncated
    ? `Showing first ${browserState.entries.length} of ${browserState.totalEntries} entries.`
    : `${browserState.totalEntries} entries`;
  directoryTreeRoot.appendChild(summary);

  if (!browserState.entries.length) {
    directoryTreeRoot.appendChild(
      buildEmptyState("This folder is empty", "Go up one level or sync back to the session directory.")
    );
    updateWorkspaceSummary();
    return;
  }

  for (const entry of browserState.entries) {
    directoryTreeRoot.appendChild(buildDirectoryEntry(entry));
  }

  updateWorkspaceSummary();
}

async function loadDirectory(targetPath = "") {
  try {
    const requestedPath =
      String(targetPath || "").trim() ||
      activeSession?.cwd ||
      cwdInput.value.trim();
    const query = requestedPath ? `?path=${encodeURIComponent(requestedPath)}` : "";
    const payload = await request(`/api/fs${query}`);

    browserState = {
      ...browserState,
      path: payload.path || "",
      parentPath: payload.parentPath || "",
      entries: payload.entries || [],
      totalEntries: payload.totalEntries || 0,
      truncated: Boolean(payload.truncated)
    };

    browserCurrentRoot.textContent = payload.path || "No folder loaded.";
    renderDirectoryBrowser();
  } catch (err) {
    setStatus(err.message || String(err));
  }
}

connectButton.addEventListener("click", async () => {
  try {
    accessToken = tokenInput.value.trim();
    if (!accessToken) {
      throw new Error("Enter the access token first.");
    }
    await loginWithToken(accessToken);
    const payload = await request("/api/config");
    accessToken = "";
    tokenInput.value = "";
    cwdInput.value = cwdInput.value.trim() || payload.defaultCwd || "";
    newSessionButton.disabled = false;
    refreshButton.disabled = false;
    setView("workspace");
    setWorkspaceScreen("home");
    setPanelOpen(false);
    setStatus("Connected. Create or open a session.");
    await refreshSessions();
    updateInputControls();
  } catch (err) {
    setStatus(err.message || String(err));
  }
});

newSessionButton.addEventListener("click", async () => {
  try {
    const payload = await request("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        cwd: cwdInput.value.trim(),
        name: nameInput.value.trim()
      })
    });
    await refreshSessions();
    await openSession(payload.session.id);
    nameInput.value = "";
  } catch (err) {
    setStatus(err.message || String(err));
  }
});

refreshButton.addEventListener("click", async () => {
  try {
    await refreshSessions();
  } catch (err) {
    setStatus(err.message || String(err));
  }
});

closeSessionButton.addEventListener("click", async () => {
  if (!activeSessionId) {
    return;
  }
  try {
    isManualDisconnect = true;
    await request(`/api/sessions/${activeSessionId}`, { method: "DELETE" });
    disconnectSocket();
    pendingOutput = "";
    term.reset();
    activeSessionId = "";
    activeSession = null;
    updateInputControls();
    updateWorkspaceSummary();
    await refreshSessions();
    setStatus("Session closed.");
    setWorkspaceScreen("home");
    setPanelOpen(false);
  } catch (err) {
    setStatus(err.message || String(err));
  }
});

openPanelButton.addEventListener("click", () => {
  setPanelOpen(true);
});

closePanelButton.addEventListener("click", () => {
  setPanelOpen(false);
});

panelBackdrop.addEventListener("click", () => {
  setPanelOpen(false);
});

backToConnectButton.addEventListener("click", () => {
  isManualDisconnect = true;
  disconnectSocket();
  closeClipboardSheet({ restoreFocus: false });
  activeSessionId = "";
  activeSession = null;
  setPanelOpen(false);
  setWorkspaceScreen("home");
  setView("connect");
  term.reset();
  setStatus("Disconnected");
  logoutSession();
  updateWorkspaceSummary();
});

backToSessionsButton.addEventListener("click", async () => {
  isManualDisconnect = true;
  disconnectSocket();
  activeSessionId = "";
  activeSession = null;
  setPanelOpen(false);
  setWorkspaceScreen("home");
  term.reset();
  await refreshSessions();
  setStatus("Choose another session.");
});

copyTerminalButton.addEventListener("click", () => {
  openClipboardSheet("copy");
});

pasteTerminalButton.addEventListener("click", () => {
  if (!hasLiveSession()) {
    setStatus("Open a session first.");
    return;
  }
  openClipboardSheet("paste");
});

clipboardPrimaryButton.addEventListener("click", async () => {
  if (clipboardTitle.textContent === "Copy Path") {
    clipboardBuffer.focus({ preventScroll: true });
    clipboardBuffer.select();
    setStatus("Path selected. Use your browser copy action.");
    return;
  }

  await handleClipboardPrimaryAction();
});

clipboardCloseButton.addEventListener("click", () => {
  closeClipboardSheet();
});

browseUpButton.addEventListener("click", async () => {
  if (!browserState.parentPath) {
    setStatus("Already at the top folder.");
    return;
  }
  await loadDirectory(browserState.parentPath);
});

syncBrowserPathButton.addEventListener("click", async () => {
  const nextPath = activeSession?.cwd || cwdInput.value.trim() || browserState.path;
  if (!nextPath) {
    setStatus("No session folder available.");
    return;
  }
  await loadDirectory(nextPath);
});

if (enableMobileComposer) {
  mobileComposer.addEventListener("click", (event) => {
    if (event.target === composerEscButton || event.target === composerSendButton) {
      return;
    }
    focusImeBridge();
  });
}

if (!useImeBridge) {
  term.onData((data) => {
    sendToSession(data);
  });
}

term.onResize(() => {
  syncTerminalSize();
});

terminalRoot.addEventListener("click", () => {
  if (useImeBridge) {
    focusImeBridge();
    return;
  }

  term.focus();
});

window.addEventListener("resize", () => {
  requestViewportMetrics();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    blurImeBridge();
    return;
  }

  requestViewportMetrics();
  if (!useImeBridge) {
    term.focus();
  }
  if (!hasLiveSession() && activeSessionId && isAuthenticated) {
    isManualDisconnect = false;
    scheduleReconnect();
  }
});

window.addEventListener("pageshow", () => {
  requestViewportMetrics();
  if (!useImeBridge) {
    term.focus();
  }
  if (!hasLiveSession() && activeSessionId && isAuthenticated) {
    isManualDisconnect = false;
    scheduleReconnect();
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && sessionPanel.classList.contains("open")) {
    setPanelOpen(false);
  }
});

window.visualViewport?.addEventListener("resize", requestViewportMetrics);
window.visualViewport?.addEventListener("scroll", requestViewportMetrics);

imeBridge.addEventListener("compositionstart", () => {
  imeComposing = true;
});

imeBridge.addEventListener("compositionend", () => {
  imeComposing = false;
  flushImeBridgeValue();
});

imeBridge.addEventListener("focus", () => {
  setComposerExpanded(true);
  syncComposerLayout();
});

imeBridge.addEventListener("blur", () => {
  if (!imeBridge.value && !keyboardWasOpen) {
    setComposerExpanded(false);
  }
  syncComposerLayout();
});

imeBridge.addEventListener("input", () => {
  flushImeBridgeValue();
});

imeBridge.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    submitImeBridge();
    return;
  }

  if (event.key === "Backspace" && !imeBridge.value && !imeComposing) {
    event.preventDefault();
    sendToSession("\u007f");
    return;
  }

  if (event.key === "Tab") {
    event.preventDefault();
    sendToSession("\t");
    imeBridge.value += "\t";
    mobileComposerValue = imeBridge.value;
    syncComposerLayout();
    return;
  }

  const arrowMap = {
    ArrowUp: "\u001b[A",
    ArrowDown: "\u001b[B",
    ArrowLeft: "\u001b[D",
    ArrowRight: "\u001b[C"
  };
  const controlValue = arrowMap[event.key];
  if (controlValue) {
    event.preventDefault();
    sendToSession(controlValue);
  }
});

composerEscButton.addEventListener("click", () => {
  sendToSession("\u001b");
  focusImeBridge();
});

composerSendButton.addEventListener("click", () => {
  submitImeBridge();
});

escKeyButton.addEventListener("click", () => {
  sendToSession("\u001b");
  if (useImeBridge && keyboardWasOpen) {
    focusImeBridge();
    return;
  }

  term.focus();
});

updateInputControls();
updateWorkspaceSummary();
setView("connect");
setWorkspaceScreen("home");
setPanelOpen(false);
syncComposerLayout();
requestViewportMetrics();
