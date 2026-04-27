const path = require("node:path");
const os = require("node:os");

const root = __dirname;
const logsDir = path.join(root, "logs");
const home = os.homedir();
const managedPath =
  process.platform === "win32"
    ? process.env.Path || process.env.PATH || ""
    : [
        path.join(home, ".npm-global", "bin"),
        "/usr/local/sbin",
        "/usr/local/bin",
        "/usr/sbin",
        "/usr/bin",
        "/sbin",
        "/bin",
        "/snap/bin"
      ].join(path.delimiter);
const baseEnv = {
  HOME: home,
  USER: process.env.USER || process.env.USERNAME || "",
  LOGNAME: process.env.LOGNAME || process.env.USER || "",
  SHELL: process.env.SHELL || "/bin/bash",
  PATH: managedPath
};

const shared = {
  script: path.join(root, "src", "server.js"),
  cwd: root,
  instances: 1,
  exec_mode: "fork",
  autorestart: true,
  restart_delay: 1200,
  kill_timeout: 5000,
  listen_timeout: 5000,
  min_uptime: "5s",
  max_restarts: 20,
  out_file: path.join(logsDir, "pm2-out.log"),
  error_file: path.join(logsDir, "pm2-error.log"),
  merge_logs: true,
  time: true,
  filter_env: ["CODEX_"],
  env: {
    ...baseEnv,
    NODE_ENV: "production"
  }
};

module.exports = {
  apps: [
    {
      ...shared,
      name: "codex-cc-web-terminal",
      watch: false
    },
    {
      ...shared,
      name: "codex-cc-web-terminal-dev",
      watch: [path.join(root, "src"), path.join(root, "public"), path.join(root, ".env")],
      ignore_watch: [
        path.join(root, "data"),
        path.join(root, "logs"),
        path.join(root, "node_modules")
      ],
      env: {
        ...baseEnv,
        NODE_ENV: "development"
      }
    }
  ]
};
