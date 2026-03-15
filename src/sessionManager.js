import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import pty from "node-pty";

const shortTimeFormatterCache = new Map();

function nowIso() {
  return new Date().toISOString();
}

function getShortTimeFormatter(timezone) {
  const key = String(timezone || "UTC");
  if (!shortTimeFormatterCache.has(key)) {
    shortTimeFormatterCache.set(
      key,
      new Intl.DateTimeFormat("en-AU", {
        timeZone: key,
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZoneName: "short"
      })
    );
  }
  return shortTimeFormatterCache.get(key);
}

function formatShortTimestamp(value, timezone) {
  const parts = getShortTimeFormatter(timezone).formatToParts(new Date(value));
  const get = (type) => parts.find((part) => part.type === type)?.value || "00";
  return `${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
}

function quotePosix(value) {
  return `'${String(value || "").replace(/'/g, "'\\''")}'`;
}

function quotePowerShell(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function buildShellCommand(parts, quoteStyle) {
  const values = parts.filter((part) => String(part || "").length > 0);
  if (values.length === 0) {
    return "";
  }

  if (quoteStyle === "powershell") {
    const [command, ...args] = values;
    const quotedArgs = args.map((arg) => quotePowerShell(arg)).join(" ");
    return quotedArgs
      ? `& ${quotePowerShell(command)} ${quotedArgs}`
      : `& ${quotePowerShell(command)}`;
  }

  return values.map((part) => quotePosix(part)).join(" ");
}

function normalizeName(value, fallback) {
  const text = String(value || "").trim();
  return text || fallback;
}

function sanitizeTitleFragment(value) {
  return String(value || "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractEmbeddedUserRequest(value) {
  const text = String(value || "");
  const userRequestMarker = "User request:";
  const userRequestIndex = text.lastIndexOf(userRequestMarker);
  if (userRequestIndex >= 0) {
    return text.slice(userRequestIndex + userRequestMarker.length).trim();
  }

  const replyMarker = "Reply with exactly:";
  const replyIndex = text.lastIndexOf(replyMarker);
  if (replyIndex >= 0) {
    return text.slice(replyIndex).trim();
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (
      !(line.startsWith("<") && line.endsWith(">")) &&
      !line.startsWith("[") &&
      !line.startsWith("Conversation info") &&
      !line.startsWith("Sender (") &&
      !line.startsWith("Bridge info") &&
      !line.startsWith("Workspace memory") &&
      !line.startsWith("Retrieved ") &&
      !line.startsWith("Available genes")
    ) {
      return line;
    }
  }

  return text.trim();
}

function deriveSessionTitle(value, fallback) {
  const clean = sanitizeTitleFragment(extractEmbeddedUserRequest(value))
    .replace(/^(codex|continue|resume)\s*/i, "")
    .trim();
  if (!clean) {
    return fallback;
  }

  if (clean.length <= 52) {
    return clean;
  }

  return `${clean.slice(0, 49).trimEnd()}...`;
}

function isLowSignalTitle(value) {
  const lower = String(value || "").trim().toLowerCase();
  if (!lower) {
    return true;
  }

  return (
    lower.startsWith("conversation info") ||
    lower.includes("safety and fallback") ||
    lower.includes("available skills") ||
    lower.includes("skill.md") ||
    lower.includes("environment_context") ||
    lower.includes("imported context from the selected codex session")
  );
}

function isBoilerplateUserText(value) {
  const original = String(value || "").trim();
  const text = extractEmbeddedUserRequest(value).trim();
  if (!original || !text) {
    return true;
  }

  const originalLower = original.toLowerCase();
  const lower = text.toLowerCase();
  return (
    (text.startsWith("<") && text.endsWith(">")) ||
    originalLower.startsWith("# agents.md instructions") ||
    originalLower.includes("### available skills") ||
    originalLower.includes("a skill is a set of local instructions") ||
    originalLower.includes("<environment_context>") ||
    originalLower.includes("</environment_context>") ||
    lower.startsWith("# agents.md instructions") ||
    lower.startsWith("<environment_context>") ||
    lower.startsWith("</environment_context>") ||
    lower.startsWith("you are running inside a local discord-controlled agent bridge") ||
    lower.includes("a skill is a set of local instructions") ||
    lower.includes("### available skills") ||
    lower.includes("<instructions>") ||
    lower.includes("</instructions>")
  );
}

function walkJsonlFiles(rootDir) {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return [];
  }

  const result = [];
  const queue = [rootDir];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (entry.isFile() && fullPath.endsWith(".jsonl")) {
        result.push(fullPath);
      }
    }
  }
  return result;
}

function readSessionPreview(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function readJsonFile(filePath, fallbackValue) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallbackValue;
  }
}

function userTextsFromPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  if (payload.type === "user_message" && payload.message) {
    return [String(payload.message)];
  }

  if (payload.role === "user" && Array.isArray(payload.content)) {
    const items = [];
    for (const item of payload.content) {
      if (item?.type === "input_text" && item.text) {
        items.push(String(item.text));
      }
    }
    return items;
  }

  return [];
}

export class SessionManager {
  constructor(config) {
    this.config = config;
    this.sessions = new Map();
    this.customNamesPath = path.join(this.config.dataDir, "session-names.json");
    this.customNames = new Map(
      Object.entries(readJsonFile(this.customNamesPath, {})).filter((entry) => entry[0] && entry[1])
    );
    fs.mkdirSync(this.config.dataDir, { recursive: true });
  }

  list() {
    return this.listLiveSessions();
  }

  listLiveSessions() {
    return [...this.sessions.values()]
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map((session) => this.serialize(session));
  }

  listAll() {
    const liveSessions = this.listLiveSessions();
    const liveByResumeId = new Set(
      liveSessions.map((session) => session.resumeSessionId).filter(Boolean)
    );
    const historySessions = this.listHistoricalSessions()
      .filter((session) => !liveByResumeId.has(session.resumeSessionId));
    return [...liveSessions, ...historySessions].sort((a, b) =>
      String(b.updatedAt).localeCompare(String(a.updatedAt))
    );
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  stats() {
    let clientCount = 0;
    let running = 0;
    let exited = 0;
    for (const session of this.sessions.values()) {
      clientCount += session.clients.size;
      if (session.status === "exited") {
        exited += 1;
      } else {
        running += 1;
      }
    }

    return {
      sessions: this.sessions.size,
      clients: clientCount,
      running,
      exited
    };
  }

  create({ cwd = "", name = "", resumeSessionId = "" } = {}) {
    const id = crypto.randomUUID();
    const resolvedCwd = this.resolveCwd(cwd);
    const fallbackName = `codex-${this.sessions.size + 1}`;
    const sessionName = normalizeName(name, fallbackName);
    const shell = pty.spawn(
      this.config.shellBin,
      this.config.shellArgs,
      {
        name: "xterm-color",
        cols: 120,
        rows: 30,
        cwd: resolvedCwd,
        env: {
          ...process.env,
          TERM: "xterm-256color"
        }
      }
    );

    const session = {
      id,
      name: sessionName,
      cwd: resolvedCwd,
      shell,
      buffer: "",
      status: "starting",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      exitCode: null,
      clients: new Set(),
      autoNamed: !String(name || "").trim(),
      fallbackName,
      inputPreview: "",
      sawCodexBootstrap: false,
      resumeSessionId: String(resumeSessionId || "").trim() || null
    };

    shell.onData((chunk) => {
      session.buffer += chunk;
      if (session.buffer.length > this.config.sessionBufferLimit) {
        session.buffer = session.buffer.slice(-this.config.sessionBufferLimit);
      }
      session.status = "running";
      session.updatedAt = nowIso();
      for (const client of session.clients) {
        client.send(JSON.stringify({ type: "data", data: chunk }));
      }
    });

    shell.onExit(({ exitCode }) => {
      session.exitCode = exitCode;
      session.status = "exited";
      session.updatedAt = nowIso();
       this.persistSessionName(session);
      for (const client of session.clients) {
        client.send(JSON.stringify({ type: "exit", exitCode }));
      }
    });

    this.sessions.set(id, session);
    shell.write(`${this.buildCodexCommand(session.resumeSessionId)}\r`);
    return this.serialize(session);
  }

  attachClient(id, ws) {
    const session = this.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }

    session.clients.add(ws);
    ws.send(
      JSON.stringify({
        type: "snapshot",
        session: this.serialize(session),
        buffer: session.buffer
      })
    );

    ws.on("close", () => {
      session.clients.delete(ws);
    });
  }

  write(id, data) {
    const session = this.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }

    const text = String(data || "");
    this.maybeAutoRename(session, text);
    session.shell.write(text);
    session.updatedAt = nowIso();
  }

  resize(id, cols, rows) {
    const session = this.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }

    session.shell.resize(Math.max(20, cols || 120), Math.max(10, rows || 30));
    session.updatedAt = nowIso();
  }

  rename(id, name) {
    const session = this.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }

    session.name = normalizeName(name, session.fallbackName || session.name);
    session.autoNamed = false;
    session.updatedAt = nowIso();
    this.persistSessionName(session);
    return this.serialize(session);
  }

  close(id) {
    const session = this.get(id);
    if (!session) {
      return false;
    }

    session.status = "closing";
    session.updatedAt = nowIso();
    try {
      session.shell.kill();
    } catch {
      // Ignore PTY kill failures.
    }
    this.sessions.delete(id);
    return true;
  }

  shutdown() {
    for (const session of [...this.sessions.values()]) {
      try {
        session.shell.kill();
      } catch {
        // Ignore PTY kill failures during shutdown.
      }
      session.clients.clear();
    }
    this.sessions.clear();
  }

  resolveCwd(cwd) {
    const value = String(cwd || "").trim();
    if (!value) {
      return this.config.defaultCwd;
    }

    const resolved = path.resolve(value);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return resolved;
    }

    return this.config.defaultCwd;
  }

  serialize(session) {
    return {
      id: session.id,
      name: session.name,
      cwd: session.cwd,
      kind: "live",
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      exitCode: session.exitCode,
      autoNamed: session.autoNamed,
      inputPreview: session.inputPreview,
      resumeSessionId: session.resumeSessionId
    };
  }

  listHistoricalSessions() {
    const files = walkJsonlFiles(this.config.codexSessionsDir);
    const byResumeId = new Map();

    for (const filePath of files) {
      try {
        const stat = fs.statSync(filePath);
        const preview = readSessionPreview(filePath);
        let id = "";
        let cwd = this.config.defaultCwd;
        let title = "";
        let firstInput = "";
        let fallbackInput = "";

        for (const line of preview.split(/\r?\n/)) {
          if (!line.trim()) {
            continue;
          }

          let record;
          try {
            record = JSON.parse(line);
          } catch {
            continue;
          }

          if (record.type === "session_meta") {
            id = String(record.payload?.id || id);
            cwd = String(record.payload?.cwd || cwd);
            title = sanitizeTitleFragment(record.payload?.thread_name || title);
          }

          const eventCandidates =
            record.type === "event_msg" ? userTextsFromPayload(record.payload) : [];
          const fallbackCandidates =
            record.type === "response_item"
              ? userTextsFromPayload(record.payload)
              : userTextsFromPayload(record);
          const candidates = eventCandidates.length > 0 ? eventCandidates : fallbackCandidates;
          for (const rawCandidate of candidates) {
            const candidate = sanitizeTitleFragment(extractEmbeddedUserRequest(rawCandidate));
            if (!candidate) {
              continue;
            }
            if (!fallbackInput) {
              fallbackInput = candidate;
            }
            if (!isBoilerplateUserText(candidate)) {
              firstInput = candidate;
              break;
            }
          }

          if (id && firstInput) {
            break;
          }
        }

        if (!id) {
          continue;
        }

        const effectivePreview = firstInput || fallbackInput || title;
        const derivedName = deriveSessionTitle(effectivePreview || title, `saved-${id.slice(0, 8)}`);
        const fallbackSavedName = `Saved ${path.basename(cwd || this.config.defaultCwd)} ${formatShortTimestamp(
          stat.mtime,
          this.config.timezone
        )}`;
        const finalName = isLowSignalTitle(derivedName) ? fallbackSavedName : derivedName;
        const customName = this.customNames.get(id);
        const session = {
          id: `history:${id}`,
          name: customName || finalName,
          cwd,
          kind: "history",
          status: "saved",
          createdAt: stat.birthtime.toISOString(),
          updatedAt: stat.mtime.toISOString(),
          exitCode: null,
          autoNamed: false,
          inputPreview: isLowSignalTitle(derivedName) ? "" : effectivePreview,
          resumeSessionId: id
        };

        const existing = byResumeId.get(id);
        if (!existing || existing.updatedAt < session.updatedAt) {
          byResumeId.set(id, session);
        }
      } catch {
        // Ignore malformed or unreadable session files.
      }
    }

    return [...byResumeId.values()].sort((a, b) =>
      String(b.updatedAt).localeCompare(String(a.updatedAt))
    );
  }

  maybeAutoRename(session, chunk) {
    if (!session.autoNamed) {
      return;
    }

    const text = String(chunk || "");
    if (!text) {
      return;
    }

    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    for (const segment of normalized.split("\n")) {
      const candidate = sanitizeTitleFragment(segment);
      if (!candidate) {
        continue;
      }

      if (!session.sawCodexBootstrap && /^codex$/i.test(candidate)) {
        session.sawCodexBootstrap = true;
        continue;
      }

      session.inputPreview = candidate;
      session.name = deriveSessionTitle(candidate, session.fallbackName);
      session.autoNamed = false;
      session.updatedAt = nowIso();
      this.persistSessionName(session);
      return;
    }
  }

  saveCustomNames() {
    const payload = Object.fromEntries([...this.customNames.entries()].sort((left, right) => {
      return left[0].localeCompare(right[0]);
    }));
    fs.writeFileSync(this.customNamesPath, JSON.stringify(payload, null, 2), "utf8");
  }

  setCustomName(resumeSessionId, name) {
    const key = String(resumeSessionId || "").trim();
    const value = String(name || "").trim();
    if (!key || !value) {
      return;
    }

    this.customNames.set(key, value);
    this.saveCustomNames();
  }

  findHistoricalMatch(session) {
    const candidates = this.listHistoricalSessions().filter((item) => item.cwd === session.cwd);
    if (!candidates.length) {
      return null;
    }

    const preview = String(session.inputPreview || "").trim().toLowerCase();
    const withSamePreview = preview
      ? candidates.filter((item) => String(item.inputPreview || "").trim().toLowerCase() === preview)
      : [];
    const pool = withSamePreview.length ? withSamePreview : candidates;
    return [...pool].sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] || null;
  }

  persistSessionName(session) {
    if (!session || session.autoNamed) {
      return;
    }

    const name = String(session.name || "").trim();
    if (!name) {
      return;
    }

    if (session.resumeSessionId) {
      this.setCustomName(session.resumeSessionId, name);
      return;
    }

    const historicalSession = this.findHistoricalMatch(session);
    if (historicalSession?.resumeSessionId) {
      this.setCustomName(historicalSession.resumeSessionId, name);
    }
  }

  buildCodexCommand(resumeSessionId) {
    const parts = [this.config.codexBin];
    if (resumeSessionId) {
      parts.push("resume", "--all", resumeSessionId);
    }
    if (this.config.codexModel) {
      parts.push("--model", this.config.codexModel);
    }
    if (this.config.codexProfile) {
      parts.push("--profile", this.config.codexProfile);
    }
    if (this.config.codexNoAltScreen) {
      parts.push("--no-alt-screen");
    }
    if (this.config.codexFullAccess) {
      parts.push("--dangerously-bypass-approvals-and-sandbox");
    }
    if (this.config.codexExtraArgs.length > 0) {
      parts.push(...this.config.codexExtraArgs);
    }
    return buildShellCommand(parts, this.config.shellQuoteStyle);
  }
}
