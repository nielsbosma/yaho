import type { Meta, StoryObj } from '@storybook/react-vite';
import type { Message } from '../lib/api.ts';
import { MessageCard } from './MessageCard.tsx';

const base: Message = {
  id: 'msg_1',
  from: 'agent:social-scout',
  to: 'human',
  type: 'info',
  title: '',
  body: '',
  reply_to: null,
  read: false,
  job: 'job_1',
  created: new Date(Date.now() - 5 * 60_000).toISOString(),
};
const reply = async () => new Promise<void>((r) => setTimeout(r, 300));

const meta: Meta<typeof MessageCard> = {
  title: 'MessageCard',
  component: MessageCard,
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof MessageCard>;

export const Question: Story = {
  args: {
    message: {
      ...base,
      from: 'agent:ads-optimiser',
      type: 'question',
      title: 'Raise the daily cap to $70?',
      body: 'CTR on the new ad set is 4.1% and CPA dropped 30%. I would like to raise the daily cap from $50 to $70 for a week.',
      choices: ['Yes, for a week', 'No, keep $50'],
    },
    onReply: reply,
    onMarkRead: () => undefined,
  },
};

export const Instruction: Story = {
  args: {
    message: {
      ...base,
      type: 'instruction',
      title: 'Comment on a Reddit thread about Excel SEO tools',
      body: 'This thread asks for exactly what the product does. Suggested comment below.',
      steps: [
        { open: 'https://www.reddit.com/r/excel/comments/abc123' },
        { copy: 'I built a tool for this — it pulls SEO data straight into Excel ...' },
      ],
    },
    onReply: reply,
  },
};

export const Info: Story = {
  args: {
    message: {
      ...base,
      from: 'agent:day-trader',
      title: 'Closed NVDA +2.1%',
      body: 'Sold 40 shares at 141.20. Day P&L +$118.',
      read: true,
    },
    onReply: reply,
  },
};

export const FromHuman: Story = {
  args: { message: { ...base, from: 'human', to: 'agent:ads-optimiser', type: 'reply', body: 'Yes, for a week', read: true } },
};

export const Compact: Story = {
  args: { message: { ...base, title: 'Daily note', body: 'A long body that is clipped in compact mode. '.repeat(10) }, compact: true },
};

export const TableAndChart: Story = {
  args: {
    message: {
      ...base,
      from: 'agent:google-analytics-daily',
      title: 'GA: search event still 0 (was 126) and Singapore bot returning (2.5K users)',
      body: [
        'GA check for filestar.com, Thu 2026-10-15 vs Thu 2026-10-08.',
        '',
        '| Metric | Oct 8 | Oct 15 | Change |',
        '|---|--:|--:|--:|',
        '| Active users | 2,052 | 16,292 | +694% |',
        '| Engagement rate | 21.0% | 3.5% | -17.5 pt |',
        '| Organic Search sessions | 729 | 925 | +27% |',
        '| download_finished | 195 | 207 | +6% |',
        '| search event | 126 | 0 | -100% |',
        '',
        '```chart',
        'type: bar',
        'title: Sessions per channel',
        'x: [Organic Search, Direct, Referral]',
        'series:',
        '  Oct 8: [729, 1383, 50]',
        '  Oct 15: [925, 15054, 35]',
        '```',
        '',
        '```chart',
        'type: line',
        'title: Singapore users per day',
        'x: [Oct 9, Oct 10, Oct 11, Oct 12, Oct 13, Oct 14, Oct 15]',
        'series:',
        '  Singapore: [80, 95, 120, 310, 575, 120, 2521]',
        '```',
      ].join('\n'),
    },
    onReply: reply,
  },
};
