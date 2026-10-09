import { describe, expect, it } from 'vite-plus/test';
import { describeCron } from './SchedulePicker.tsx';

describe('describeCron', () => {
  it('names the shapes the picker writes', () => {
    expect(describeCron('0 * * * *')).toBe('Every hour');
    expect(describeCron('15 * * * *')).toBe('Every hour at :15');
    expect(describeCron('0 7 * * *')).toBe('Every day at 07:00');
    expect(describeCron('30 9 * * 1-5')).toBe('Weekdays at 09:30');
    expect(describeCron('0 9 * * 1')).toBe('Every Monday at 09:00');
    expect(describeCron('0 9 * * 7')).toBe('Every Sunday at 09:00');
  });

  it('shows anything else as the cron itself', () => {
    expect(describeCron('0 8,17 * * *')).toBe('cron 0 8,17 * * *');
    expect(describeCron('*/5 * * * *')).toBe('cron */5 * * * *');
  });
});
