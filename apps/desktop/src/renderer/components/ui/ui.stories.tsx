import type { Meta, StoryObj } from '@storybook/react-vite';
import { Play, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from './button.tsx';
import { Dialog } from './dialog.tsx';
import { Badge, Card, CountPill, Empty, ErrorNote, PageHeader, Section, StatusBadge, Tabs } from './display.tsx';
import { Field, Input, ListInput, Switch, Textarea } from './form.tsx';

const meta: Meta = { title: 'UI' };
export default meta;
type Story = StoryObj;

export const Buttons: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="primary">
        <Play /> Run Now
      </Button>
      <Button>
        <Plus /> New Agent
      </Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="danger">
        <Trash2 /> Delete
      </Button>
      <Button variant="link">Link</Button>
      <Button size="sm">Small</Button>
      <Button size="lg" variant="primary">
        Large
      </Button>
      <Button disabled>Disabled</Button>
    </div>
  ),
};

export const FormFields: Story = {
  render: function Render() {
    const [on, setOn] = useState(true);
    const [models, setModels] = useState(['claude-sonnet-5-5', 'claude-haiku-5-5']);
    return (
      <div className="grid max-w-2xl gap-4 md:grid-cols-2">
        <Field label="Name" hint="Lowercase letters, digits and dashes.">
          <Input placeholder="social-scout" />
        </Field>
        <Field label="Allowed models">
          <ListInput value={models} onChange={setModels} />
        </Field>
        <Field label="Briefing" className="md:col-span-2">
          <Textarea defaultValue="Find relevant Reddit posts and draft a fitting comment." />
        </Field>
        <Field label="Enabled">
          <div className="flex h-9 items-center">
            <Switch checked={on} onChange={setOn} label="Enabled" />
          </div>
        </Field>
      </div>
    );
  },
};

export const Badges: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Badge>neutral</Badge>
      <Badge tone="accent">accent</Badge>
      <Badge tone="ok">ok</Badge>
      <Badge tone="warn">warn</Badge>
      <Badge tone="danger">danger</Badge>
      <Badge tone="info">info</Badge>
      {['queued', 'running', 'finished', 'sleeping', 'failed', 'budget_exhausted', 'stopped'].map((s) => (
        <StatusBadge key={s} status={s} />
      ))}
      <div className="flex w-24 rounded-lg bg-sidebar p-2 text-sm">
        Inbox <CountPill n={3} />
      </div>
    </div>
  ),
};

export const Cards: Story = {
  render: () => (
    <div className="max-w-xl space-y-6">
      <Card className="p-4">A card holds one thing: an agent, a project, a message.</Card>
      <Section title="Section">
        <Card className="p-4 text-sm">Section content</Card>
      </Section>
      <ErrorNote>agent budget of $0.02 is spent</ErrorNote>
    </div>
  ),
};

export const Header: Story = {
  parameters: { layout: 'fullscreen' },
  render: function Render() {
    const [tab, setTab] = useState('overview');
    return (
      <>
        <PageHeader
          title="social-scout"
          sub="claude-code · claude-haiku-5-5 · inbox"
          actions={
            <Button variant="primary">
              <Play /> Run Now
            </Button>
          }
        />
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'overview', label: 'Overview' },
            { id: 'edit', label: 'Definition' },
            { id: 'briefings', label: 'Briefing History' },
          ]}
        />
      </>
    );
  },
};

export const EmptyState: Story = {
  render: () => (
    <Empty icon={<Play />} title="Nothing running">
      Jobs start from cron schedules, inbox messages, delays, or Run now on an agent.
    </Empty>
  ),
};

export const DialogBox: Story = {
  render: function Render() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Open Dialog</Button>
        <Dialog
          open={open}
          onClose={() => setOpen(false)}
          title="Change Budget"
          footer={
            <>
              <Button onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => setOpen(false)}>
                Save
              </Button>
            </>
          }
        >
          <Field label="Budget in USD">
            <Input type="number" defaultValue="30" />
          </Field>
        </Dialog>
      </>
    );
  },
};
