import { describe, expect, it } from 'vite-plus/test';
import { fromChatCompletion, toChatCompletions } from './bridge.ts';

describe('Anthropic Messages to Chat Completions', () => {
  it('turns system, tool calls and tool results into the OpenAI shape', () => {
    const out = toChatCompletions({
      model: 'moonshotai/Kimi-K3',
      system: [{ type: 'text', text: 'Be brief.' }],
      max_tokens: 100,
      stream: true,
      tools: [{ name: 'Write', description: 'Write a file', input_schema: { type: 'object' } }],
      messages: [
        { role: 'user', content: 'Write hello.txt' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Writing.' },
            { type: 'tool_use', id: 'toolu_1', name: 'Write', input: { file_path: 'hello.txt' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'ok' }] },
            { type: 'text', text: 'Thanks' },
          ],
        },
      ],
    });
    expect(out.messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Write hello.txt' },
      {
        role: 'assistant',
        content: 'Writing.',
        tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'Write', arguments: '{"file_path":"hello.txt"}' } }],
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'ok' },
      { role: 'user', content: 'Thanks' },
    ]);
    expect(out.tools).toEqual([
      { type: 'function', function: { name: 'Write', description: 'Write a file', parameters: { type: 'object' } } },
    ]);
    expect(out.stream_options).toEqual({ include_usage: true });
  });

  it('turns a reply back into content blocks, with tool ids Anthropic accepts', () => {
    const back = fromChatCompletion('m', {
      choices: [
        {
          message: { content: 'Done', tool_calls: [{ id: 'Write:0', function: { name: 'Write', arguments: '{"a":1}' } }] },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    });
    expect(back.content).toEqual([
      { type: 'text', text: 'Done' },
      { type: 'tool_use', id: 'toolu_Write_0', name: 'Write', input: { a: 1 } },
    ]);
    expect(back.stop_reason).toBe('tool_use');
    expect(back.usage).toEqual({ input_tokens: 10, output_tokens: 3 });
  });
});

describe('OpenAI', () => {
  it('gets max_completion_tokens instead of max_tokens; other providers keep max_tokens', async () => {
    const { forProvider } = await import('./providerApi.ts');
    expect(forProvider('openai', { model: 'gpt-x', max_tokens: 50 })).toEqual({ model: 'gpt-x', max_completion_tokens: 50 });
    expect(forProvider('berget', { model: 'm', max_tokens: 50 })).toEqual({ model: 'm', max_tokens: 50 });
  });
});
