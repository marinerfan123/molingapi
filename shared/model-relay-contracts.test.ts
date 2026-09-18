import { describe, expect, it } from 'vitest';
import { isTerminalTaskStatus, normalizeModelId } from './model-relay-contracts';

describe('model relay contracts', () => {
  it('uses canonical modelId before display aliases', () => {
    expect(normalizeModelId({ modelId: 'flux-1', model: 'Flux 1' })).toBe('flux-1');
    expect(normalizeModelId({ modelId: '', model: 'Flux 1' })).toBe('Flux 1');
  });

  it('recognizes only the three terminal task states', () => {
    expect(isTerminalTaskStatus('done')).toBe(true);
    expect(isTerminalTaskStatus('failed')).toBe(true);
    expect(isTerminalTaskStatus('canceled')).toBe(true);
    expect(isTerminalTaskStatus('running')).toBe(false);
  });
});
