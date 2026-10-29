import { expect, it } from 'vitest';
import { activationBlockers } from '../packages/shared/src/browser.js';
import { MODELS } from '../packages/analysis/src/models.js';
import type { AiSettings } from '../packages/shared/src/browser.js';

const settings: AiSettings = { allowImageSharing: false, analyzeModel: 'claude-haiku-5-5', promptModel: 'claude-haiku-5-5', allowModelTraining: false };

it('requires sharing consent, not a local allowance or a second enable switch', () => {
  const blockers = activationBlockers(settings, true, [...MODELS]);
  expect(blockers).toHaveLength(1);
  expect(blockers.join(' ')).toContain('image-sharing');
  expect(blockers.join(' ')).not.toContain('guardrail');
  expect(blockers.join(' ')).not.toContain('API key');
});

it('is ready automatically with a server key, sharing consent, and valid vision models', () => {
  expect(activationBlockers({ ...settings, allowImageSharing: true }, true, [...MODELS])).toEqual([]);
});

it('distinguishes missing credentials, unavailable models, and provider-training consent', () => {
  expect(activationBlockers({ ...settings, allowImageSharing: true }, false, [...MODELS]).join(' ')).toContain('API key');
  expect(activationBlockers({ ...settings, allowImageSharing: true }, true, []).join(' ')).toContain('current Go catalog');
  expect(activationBlockers({ ...settings, analyzeModel: 'muse-spark-1.3-contributor', allowImageSharing: true }, true, [...MODELS]).join(' ')).toContain('provider training');
});
