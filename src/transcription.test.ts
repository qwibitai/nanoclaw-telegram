import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks ---

const mockEnv: Record<string, string> = {};

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  createWhisperProvider,
  createTranscriptionProvider,
  transcribeAudio,
  type TranscriptionProvider,
} from './transcription.js';

// --- Tests ---

describe('createWhisperProvider', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends correct request to OpenAI Whisper API', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('Hello, this is a test.'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const provider = createWhisperProvider('sk-test-key');
    const result = await provider(Buffer.from('fake-audio'), 'audio/ogg');

    expect(result).toBe('Hello, this is a test.');
    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer sk-test-key');
    expect(opts.body).toBeInstanceOf(FormData);
  });

  it('throws on non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      }),
    );

    const provider = createWhisperProvider('sk-bad-key');
    await expect(
      provider(Buffer.from('fake-audio'), 'audio/ogg'),
    ).rejects.toThrow('Whisper API 401: Unauthorized');
  });
});

describe('createTranscriptionProvider', () => {
  beforeEach(() => {
    Object.keys(mockEnv).forEach((k) => delete mockEnv[k]);
  });

  it('returns null when no API key is set', () => {
    const provider = createTranscriptionProvider();
    expect(provider).toBeNull();
  });

  it('returns a provider when OPENAI_API_KEY is set', () => {
    mockEnv.OPENAI_API_KEY = 'sk-test';
    const provider = createTranscriptionProvider();
    expect(provider).toBeTypeOf('function');
  });
});

describe('transcribeAudio', () => {
  it('returns null when provider is null', async () => {
    const result = await transcribeAudio(null, Buffer.from('audio'), 'audio/ogg');
    expect(result).toBeNull();
  });

  it('returns transcript on success', async () => {
    const provider: TranscriptionProvider = vi
      .fn()
      .mockResolvedValue('transcribed text');
    const result = await transcribeAudio(
      provider,
      Buffer.from('audio'),
      'audio/ogg',
    );
    expect(result).toBe('transcribed text');
  });

  it('returns null on provider error', async () => {
    const provider: TranscriptionProvider = vi
      .fn()
      .mockRejectedValue(new Error('API down'));
    const result = await transcribeAudio(
      provider,
      Buffer.from('audio'),
      'audio/ogg',
    );
    expect(result).toBeNull();
  });
});
