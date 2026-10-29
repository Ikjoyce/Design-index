import { describe, expect, it } from 'vitest';
import { CAPABILITIES_URL, createGoProvider, filterVisionCatalog, GO_MODELS_URL, MODELS, ProviderError, refreshCatalog, validateAnalysis, validatePrompt } from '../packages/analysis/src/index.js';
import type { ModelRequest } from '../packages/analysis/src/index.js';
import { analysisFixture, promptFixture } from './analysis-fixtures.js';
import sharp from 'sharp';
import { imageFixture } from './helpers.js';

function request(stage: ModelRequest['stage'] = 'analyze'): ModelRequest {
  return { stage, modelId: 'claude-haiku-5-5', sessionId: 'test-session-123', text: 'Prepare a coding-agent design reference.', signal: new AbortController().signal };
}
function response(output: unknown, extraUsage = {}) {
  return Response.json({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-haiku-5-5',
    content: [{ type: 'text', text: JSON.stringify(output) }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 150, ...extraUsage },
  });
}

describe('OpenCode Go transport', () => {
  it('uses only the Go endpoint, bearer authentication, honest identity, and stable conversation headers', async () => {
    const calls: { url: string; headers: Headers; init?: RequestInit }[] = [];
    const transport: typeof fetch = async (url, init) => { calls.push({ url: String(url), headers: new Headers(init?.headers), init }); return response(analysisFixture()); };
    const provider = createGoProvider('unit-test-key-not-a-real-credential', transport);
    const result = await provider.generate(request());
    await provider.generate(request());
    expect(result.output).toEqual(analysisFixture());
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(150);
    for (const call of calls) {
      expect(call.url).toBe('https://opencode.ai/inference/go/anthropic/v1/messages');
      expect(call.headers.get('authorization')).toBe('Bearer unit-test-key-not-a-real-credential');
      expect(call.headers.has('x-api-key')).toBe(false);
      expect(call.headers.get('user-agent')).toBe('design-index/0.2.0');
      expect(call.headers.get('x-opencode-session')).toBe('test-session-123');
      expect(call.init?.redirect).toBe('error');
      expect(String(call.init?.body)).not.toContain('unit-test-key-not-a-real-credential');
    }
  });

  it('does not retry or fall back to paid endpoints on a Go limit/authentication error', async () => {
    let calls = 0;
    const provider = createGoProvider('unit-secret', async () => { calls++; return Response.json({ error: { message: 'unit-secret must not escape' } }, { status: 403 }); });
    await expect(provider.generate(request())).rejects.toMatchObject({ code: 'credentials', message: 'credentials' });
    expect(calls).toBe(1);
  });

  it('leaves Extra Usage and balance billing decisions to the Go account', async () => {
    const provider = createGoProvider('unit-secret', async () => response(analysisFixture(), { cost: 0.05, opencode: { billing_source: 'balance' } }));
    expect((await provider.generate(request())).output).toEqual(analysisFixture());
  });

  it('returns invalid output normally even when Go uses account-configured Extra Usage', async () => {
    const provider = createGoProvider('unit-secret', async () => response({ invalid: true }, { cost: 0.05, opencode: { billing_source: 'balance' } }));
    expect((await provider.generate(request())).output).toBeNull();
  });

  it('returns an explicit Go rate limit with its Retry-After delay and never retries inside the SDK', async () => {
    let calls = 0;
    const provider = createGoProvider('unit-secret', async () => { calls++; return Response.json({ error: { message: 'account limit' } }, { status: 429, headers: { 'Retry-After': '12' } }); });
    await expect(provider.generate(request())).rejects.toMatchObject({ code: 'limits', retryAfterMs: 12000 });
    expect(calls).toBe(1);
  });

  it('returns invalid JSON output with its usage so the worker can account for a validation retry', async () => {
    const provider = createGoProvider('unit-secret', async () => response({ broken: true }));
    const result = await provider.generate(request());
    expect(result.output).toBeNull();
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(150);
  });

  it('rejects unsupported models locally and never sends a request', async () => {
    let called = false;
    const provider = createGoProvider('unit-secret', async () => { called = true; return response(analysisFixture()); });
    await expect(provider.generate({ ...request(), modelId: 'claude-sonnet-5-5' })).rejects.toBeInstanceOf(ProviderError);
    expect(called).toBe(false);
    expect(MODELS.every((model) => model.vision)).toBe(true);
  });

  it('refreshes the public Go catalog without a key and does not invent capabilities for unknown models', async () => {
    const models = await refreshCatalog(async (url, init) => {
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      if (String(url) === GO_MODELS_URL) return Response.json({ data: [{ id: 'claude-haiku-5-5' }, { id: 'deepseek-v4.1-flash' }, { id: 'unknown-vision-maybe' }, { id: 'claude-sonnet-5-5' }] });
      expect(String(url)).toBe(CAPABILITIES_URL);
      return Response.json({ 'opencode-go': { models: {
        'claude-haiku-5-5': { modalities: { input: ['text', 'image'], output: ['text'] } },
        'deepseek-v4.1-flash': { modalities: { input: ['text', 'image'], output: ['text'] } },
        'unknown-vision-maybe': { modalities: { input: ['text', 'image'], output: ['text'] } },
      } } });
    });
    expect(models.map((model) => model.id)).toEqual(['claude-haiku-5-5', 'deepseek-v4.1-flash']);
  });

  it('requires explicit image input and Go membership, never a family-name guess', () => {
    const inventory = { data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4.1-flash' }, { id: 'gpt-6-luna' }, { id: 'gemini-4-argon' }] };
    const metadata = { 'opencode-go': { models: {
      'deepseek-v4-pro': { modalities: { input: ['text'], output: ['text'] } },
      'deepseek-v4.1-flash': { modalities: { input: ['text', 'image'], output: ['text'] } },
      'gpt-6-luna': { modalities: { input: ['text'], output: ['text'] } },
      'gemini-4-argon': { attachment: true }, // Attachments alone do not confirm image input.
    } }, opencode: { models: { 'gpt-6-luna': { modalities: { input: ['text', 'image'], output: ['text'] } } } } };
    expect(filterVisionCatalog(inventory, metadata).map((model) => model.id)).toEqual(['deepseek-v4.1-flash']);
  });

  it('uses exact matching Console capabilities for legacy Go entries, not an unrelated model', () => {
    const inventory = { data: [{ id: 'kimi-k2.6' }, { id: 'qwen3.7-max' }, { id: 'deepseek-v4.1-flash-free' }] };
    const metadata = { 'opencode-go': { models: {} }, opencode: { models: {
      'kimi-k2.6': { modalities: { input: ['text', 'image'], output: ['text'] } },
      'qwen3.8-max': { modalities: { input: ['text', 'image'], output: ['text'] } },
    } } };
    expect(filterVisionCatalog(inventory, metadata).map((model) => model.id)).toEqual(['kimi-k2.6']);
  });

  it('refuses Contributor training without separate consent before any HTTP request', async () => {
    let called = false;
    const provider = createGoProvider('unit-secret', async () => { called = true; return response(analysisFixture()); });
    await expect(provider.generate({ ...request(), modelId: 'muse-spark-1.3-contributor' })).rejects.toMatchObject({ code: 'privacy' });
    expect(called).toBe(false);
  });

  it.each(MODELS)('routes image input correctly for $id', async (model) => {
    const image = await sharp(await imageFixture()).webp().toBuffer();
    let calls = 0;
    const provider = createGoProvider('unit-secret', async (url, init) => {
      calls++;
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer unit-secret');
      expect(headers.get('x-opencode-session')).toBe('test-session-123');
      expect(headers.get('user-agent')).toBe('design-index/0.2.0');
      expect(headers.has('x-goog-api-key')).toBe(false);
      expect(String(url)).not.toContain('unit-secret');
      const body = JSON.parse(String(init?.body));
      const expected = model.apiFamily === 'anthropic' ? '/anthropic/v1/messages' : model.apiFamily === 'google' ? '/google/v1beta/models/gemini-4-argon:generateContent' : model.apiFamily === 'responses' ? '/openai/v1/responses' : '/openai/v1/chat/completions';
      expect(String(url)).toBe(`https://opencode.ai/inference/go${expected}`);
      if (model.apiFamily === 'anthropic') {
        expect(body.messages[0].content.some((part: { type: string; source?: { media_type?: string; data?: string } }) => part.type === 'image' && part.source?.media_type === 'image/webp' && part.source.data === image.toString('base64'))).toBe(true);
        if (body.tools?.some((tool: { name?: string }) => tool.name === 'json')) {
          return Response.json({ id: 'msg_test', type: 'message', role: 'assistant', model: model.id,
            content: [{ type: 'tool_use', id: 'json_result', name: 'json', input: analysisFixture() }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 150 },
          });
        }
        return response(analysisFixture());
      }
      if (model.apiFamily === 'google') {
        expect(body.contents[0].parts.some((part: { inlineData?: { mimeType?: string; data?: string } }) => part.inlineData?.mimeType === 'image/webp' && part.inlineData.data === image.toString('base64'))).toBe(true);
        return Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(analysisFixture()) }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 150, totalTokenCount: 250 } });
      }
      expect(JSON.stringify(body)).toContain(`data:image/webp;base64,${image.toString('base64')}`);
      if (model.apiFamily === 'responses') {
        expect(body.store).toBe(false);
        expect(body.reasoning.effort).toBe('low');
        return Response.json({ id: 'resp_test', object: 'response', created_at: 1793000000, status: 'completed', model: model.id,
          output: [{ type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(analysisFixture()), annotations: [] }] }],
          usage: { input_tokens: 100, output_tokens: 150, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
        });
      }
      return Response.json({ id: 'chatcmpl_test', object: 'chat.completion', created: 1793000000, model: model.id,
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(analysisFixture()) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 150, total_tokens: 250 },
      });
    });
    const reply = await provider.generate({ ...request(), modelId: model.id, image, allowModelTraining: model.trainsOnData });
    expect(reply.output).toEqual(analysisFixture());
    expect(reply.inputTokens).toBe(100);
    expect(reply.outputTokens).toBe(150);
    expect(calls).toBe(1);
  });
});

describe('analysis validation', () => {
  it('rejects invented colors and vocabulary labels', () => {
    expect(validateAnalysis(analysisFixture('#FFFFFF'), [{ hex: '#7C5CFF' }])).toBeNull();
    const result = analysisFixture();
    result.labels.style = [{ value: 'made-up-style', confidence: 0.9 }];
    expect(validateAnalysis(result, [{ hex: '#7C5CFF' }])).toBeNull();
  });

  it('forces still-image motion to unknown and flags low confidence', () => {
    const result = analysisFixture();
    result.labels.motion = [{ value: 'parallax', confidence: 0.9 }];
    result.labels.style[0]!.confidence = 0.4;
    const validated = validateAnalysis(result, [{ hex: '#7C5CFF' }]);
    expect(validated?.labels.motion).toEqual([{ value: 'unknown', confidence: 1 }]);
    expect(validated?.review.needs_review).toBe(true);
    expect(validated?.review.reasons.length).toBeGreaterThan(0);
  });

  it('validates prompt colors as well as analysis colors', () => {
    expect(validatePrompt(promptFixture('#FFFFFF'), [{ hex: '#7C5CFF' }])).toBeNull();
    expect(validatePrompt(promptFixture(), [{ hex: '#7C5CFF' }])).toEqual(promptFixture());
  });

  it('does not allow invented colors to hide in notes or assumptions', () => {
    const analysis = analysisFixture();
    analysis.type_notes = 'Use #FFFFFF headings.';
    expect(validateAnalysis(analysis, [{ hex: '#7C5CFF' }])).toBeNull();
    const prompt = promptFixture();
    prompt.assumptions.push('A #FFFFFF surface would help.');
    expect(validatePrompt(prompt, [{ hex: '#7C5CFF' }])).toBeNull();
  });
});
