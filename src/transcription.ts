/**
 * Voice message transcription module.
 *
 * Provides a provider-based interface for transcribing audio to text.
 * Currently supports OpenAI Whisper API. Adding new providers (Groq,
 * Deepgram, local whisper.cpp) requires only a new factory function.
 *
 * Similar to the voice transcription implementation in nanoclaw-whatsapp
 * (see qwibitai/nanoclaw-whatsapp, branch skill/voice-transcription).
 */
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

/**
 * A transcription provider converts an audio buffer into text.
 */
export type TranscriptionProvider = (
  audio: Buffer,
  mimeType: string,
) => Promise<string>;

/**
 * Create a provider that uses OpenAI's Whisper API.
 */
export function createWhisperProvider(apiKey: string): TranscriptionProvider {
  return async (audio: Buffer, mimeType: string): Promise<string> => {
    const ext = mimeType === 'audio/ogg' ? 'ogg' : 'wav';
    const form = new FormData();
    form.append(
      'file',
      new Blob([audio], { type: mimeType }),
      `voice.${ext}`,
    );
    form.append('model', 'whisper-1');
    form.append('response_format', 'text');

    const res = await fetch(
      'https://api.openai.com/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      },
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Whisper API ${res.status}: ${body}`);
    }

    return (await res.text()).trim();
  };
}

/**
 * Create a transcription provider based on available environment variables.
 * Returns null if no provider can be configured (voice transcription disabled).
 */
export function createTranscriptionProvider(): TranscriptionProvider | null {
  const env = readEnvFile(['OPENAI_API_KEY']);
  const key = env.OPENAI_API_KEY;
  if (!key) {
    logger.debug('No OPENAI_API_KEY — voice transcription disabled');
    return null;
  }
  logger.info('Voice transcription enabled (OpenAI Whisper)');
  return createWhisperProvider(key);
}

/**
 * Transcribe audio using the given provider. Returns the transcript text,
 * or null if the provider is null or transcription fails for any reason.
 */
export async function transcribeAudio(
  provider: TranscriptionProvider | null,
  audio: Buffer,
  mimeType: string,
): Promise<string | null> {
  if (!provider) return null;
  try {
    const text = await provider(audio, mimeType);
    logger.info({ length: text.length }, 'Transcribed voice message');
    return text;
  } catch (err) {
    logger.debug({ err }, 'Transcription failed, falling back to placeholder');
    return null;
  }
}
