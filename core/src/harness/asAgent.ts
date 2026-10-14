/**
 * The server version runs agents as their own user (YAHO_AGENT_UID, set by the Docker image), apart from the core's:
 * an agent then cannot read the API token, the database, settings.yaml, Dopbase's data or the core's environment.
 * The core holds only the capabilities to switch user and to stop those processes; setpriv drops every capability
 * before the harness starts, and no-new-privs keeps the agent from gaining any back. Files an agent and the core share
 * (workspaces, projects, the agents' home) belong to a group both are in, and the agent's umask keeps them so.
 *
 * On the desktop nothing changes: agents run as the person, as everything else they start does.
 */
export function asAgent(command: string, args: string[]): [string, string[]] {
  const uid = process.env.YAHO_AGENT_UID;
  const gid = process.env.YAHO_AGENT_GID ?? uid;
  if (!uid || process.platform === 'win32') return [command, args];
  return [
    'setpriv',
    [
      `--reuid=${uid}`,
      `--regid=${gid}`,
      '--clear-groups',
      '--inh-caps=-all',
      '--ambient-caps=-all',
      '--no-new-privs',
      '--',
      '/bin/sh',
      '-c',
      // The agents' own home (their gh and git sign-ins, Claude Code's sessions), not the core's.
      'umask 007; if [ -n "${YAHO_AGENT_HOME:-}" ]; then export HOME="$YAHO_AGENT_HOME" CLAUDE_CONFIG_DIR="$YAHO_AGENT_HOME/.claude" XDG_CACHE_HOME="$YAHO_AGENT_HOME/.cache"; fi; exec "$@"',
      'yaho-agent',
      command,
      ...args,
    ],
  ];
}

/**
 * A helper the core runs as itself (Dopbase, gh, npm). On the server the core holds the capabilities to switch user and
 * to stop agents' processes; such a child keeps the core's user but none of those.
 */
export function withoutCaps(command: string, args: string[]): [string, string[]] {
  if (!process.env.YAHO_AGENT_UID || process.platform !== 'linux') return [command, args];
  return ['setpriv', ['--inh-caps=-all', '--ambient-caps=-all', '--', command, ...args]];
}

/**
 * What a process started as the agent sees of the core's environment: what programs need to run (paths, locale, temp,
 * proxies and certificates, the desktop session, Windows' own variables). Keys and passwords the core has never pass.
 */
const ALLOW =
  /^(PATH|PATHEXT|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TERM|COLORTERM|TMPDIR|TEMP|TMP|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_[A-Z_]+|DBUS_SESSION_BUS_ADDRESS|(HTTPS?|NO|ALL)_PROXY|SSL_CERT_(FILE|DIR)|NODE_EXTRA_CA_CERTS|REQUESTS_CA_BUNDLE|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|USERPROFILE|USERNAME|USERDOMAIN|COMPUTERNAME|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|COMMONPROGRAMFILES|COMMONPROGRAMFILES\(X86\)|ALLUSERSPROFILE|PUBLIC|OS|PROCESSOR_[A-Z0-9_]+|NUMBER_OF_PROCESSORS|CLAUDE_CODE_GIT_BASH_PATH|YAHO_AGENT_HOME)$/i;

export function agentEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) if (v !== undefined && ALLOW.test(k)) env[k] = v;
  return env;
}

/** Another Claude or Codex session's identity and credentials, and Yaho's own settings and passwords. */
const NEVER = /^(CLAUDECODE.*|CLAUDE_CODE_ENTRYPOINT|ANTHROPIC_.*|OPENAI_API_KEY|OPENAI_BASE_URL|CODEX_.*|YAHO_.*)$/i;

/**
 * The base environment of a job's harness. Run as the agents' user (the server): agentEnv only. On the desktop the
 * agent is the person, whose tools may need their own variables: everything but credentials and Yaho's own.
 */
export function jobEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (process.env.YAHO_AGENT_UID && process.platform !== 'win32') return agentEnv(source);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) if (v !== undefined && (!NEVER.test(k) || k === 'YAHO_AGENT_HOME')) env[k] = v;
  return env;
}
