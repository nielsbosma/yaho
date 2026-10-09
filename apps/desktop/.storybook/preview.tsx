import type { Preview } from '@storybook/react-vite';
import '../src/renderer/index.css';

const preview: Preview = {
  parameters: { layout: 'padded', backgrounds: { disable: true } },
  decorators: [
    (Story) => (
      <div className="bg-bg p-4 text-ink">
        <Story />
      </div>
    ),
  ],
};
export default preview;
