/**
 * The Slack app each person creates for their own Yaho: Socket Mode (no public URL), a bot that DMs the inbox, the
 * App Home tab and /yaho. Opened with Slack's documented link, which pre-fills the app creation flow.
 */
export function slackManifest() {
  return {
    display_information: {
      name: 'Yaho',
      description: "Your Yaho agents' inbox",
      background_color: '#1c211e',
    },
    features: {
      app_home: { home_tab_enabled: true, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: 'Yaho', always_online: false },
      slash_commands: [
        {
          command: '/yaho',
          description: 'Run an agent, message one, or ask Yaho',
          usage_hint: 'run bugsink · send bugsink … · ask … · inbox',
          should_escape: false,
        },
      ],
    },
    oauth_config: {
      scopes: {
        bot: ['chat:write', 'chat:write.customize', 'im:history', 'im:write', 'commands', 'reactions:read', 'users:read'],
      },
    },
    settings: {
      event_subscriptions: { bot_events: ['message.im', 'app_home_opened', 'reaction_added'] },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

export const slackCreateUrl = () =>
  `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(slackManifest()))}`;
