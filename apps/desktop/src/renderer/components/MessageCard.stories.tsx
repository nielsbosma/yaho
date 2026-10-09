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
