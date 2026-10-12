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
