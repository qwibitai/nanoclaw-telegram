import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', () => ({
  default: {
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
}));

// Mock https — configured per test
const mockHttpsGet = vi.fn();
vi.mock('https', () => ({
  default: {
    get: (...args: unknown[]) => mockHttpsGet(...args),
  },
}));

import {
  pickBestPhotoSize,
  sanitizeFilename,
  ensureAttachmentsDir,
  parseMediaReferences,
} from './telegram-media.js';
import fs from 'fs';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- pickBestPhotoSize ---

describe('pickBestPhotoSize', () => {
  it('picks the largest size within dimension limit', () => {
    const sizes = [
      { file_id: 'a', file_unique_id: 'ua', width: 90, height: 90 },
      { file_id: 'b', file_unique_id: 'ub', width: 320, height: 320 },
      { file_id: 'c', file_unique_id: 'uc', width: 800, height: 800 },
      { file_id: 'd', file_unique_id: 'ud', width: 1280, height: 1280 },
      { file_id: 'e', file_unique_id: 'ue', width: 2560, height: 2560 },
    ];

    const result = pickBestPhotoSize(sizes);
    expect(result.file_id).toBe('d'); // 1280 <= 1568
  });

  it('returns smallest when all exceed limit', () => {
    const sizes = [
      { file_id: 'a', file_unique_id: 'ua', width: 2000, height: 2000 },
      { file_id: 'b', file_unique_id: 'ub', width: 3000, height: 3000 },
    ];

    const result = pickBestPhotoSize(sizes);
    expect(result.file_id).toBe('a'); // smallest of the oversized
  });

  it('handles single photo size', () => {
    const sizes = [
      { file_id: 'x', file_unique_id: 'ux', width: 640, height: 480 },
    ];

    const result = pickBestPhotoSize(sizes);
    expect(result.file_id).toBe('x');
  });

  it('throws on empty array', () => {
    expect(() => pickBestPhotoSize([])).toThrow('No photo sizes available');
  });

  it('handles non-square photos correctly', () => {
    const sizes = [
      { file_id: 'a', file_unique_id: 'ua', width: 1568, height: 800 },
      { file_id: 'b', file_unique_id: 'ub', width: 1600, height: 800 },
    ];

    const result = pickBestPhotoSize(sizes);
    expect(result.file_id).toBe('a'); // 1568 <= 1568, 800 <= 1568
  });
});

// --- sanitizeFilename ---

describe('sanitizeFilename', () => {
  it('prefixes with message ID', () => {
    expect(sanitizeFilename('report.pdf', '42')).toBe('42-report.pdf');
  });

  it('returns fallback for undefined name', () => {
    expect(sanitizeFilename(undefined, '42')).toBe('doc-42');
  });

  it('strips directory traversal', () => {
    expect(sanitizeFilename('../../../etc/passwd', '42')).toBe('42-passwd');
  });

  it('strips null bytes', () => {
    expect(sanitizeFilename('file\0.txt', '42')).toBe('42-file.txt');
  });

  it('truncates long filenames preserving extension', () => {
    const longName = 'a'.repeat(250) + '.pdf';
    const result = sanitizeFilename(longName, '42');
    expect(result.length).toBeLessThanOrEqual(210); // 42- prefix + 200 limit
    expect(result).toMatch(/\.pdf$/);
  });
});

// --- ensureAttachmentsDir ---

describe('ensureAttachmentsDir', () => {
  it('creates attachments subdirectory', () => {
    ensureAttachmentsDir('/groups/main');
    expect(fs.mkdirSync).toHaveBeenCalledWith('/groups/main/attachments', {
      recursive: true,
    });
  });

  it('returns the attachments path', () => {
    const result = ensureAttachmentsDir('/groups/main');
    expect(result).toBe('/groups/main/attachments');
  });
});

// --- parseMediaReferences ---

describe('parseMediaReferences', () => {
  it('extracts photo references', () => {
    const text = 'Here is the image:\n[Photo: attachments/photo-42.jpg]\nWhat do you think?';
    const { refs, plainText } = parseMediaReferences(text);
    expect(refs).toEqual([{ type: 'photo', relativePath: 'attachments/photo-42.jpg' }]);
    expect(plainText).toBe('Here is the image:\nWhat do you think?');
  });

  it('extracts document references', () => {
    const text = '[Document: attachments/report.pdf]\nSee the summary above.';
    const { refs, plainText } = parseMediaReferences(text);
    expect(refs).toEqual([{ type: 'document', relativePath: 'attachments/report.pdf' }]);
    expect(plainText).toBe('See the summary above.');
  });

  it('extracts multiple mixed references', () => {
    const text = '[Photo: attachments/a.jpg]\n[Document: attachments/b.pdf]\nDone.';
    const { refs, plainText } = parseMediaReferences(text);
    expect(refs).toHaveLength(2);
    expect(refs[0].type).toBe('photo');
    expect(refs[1].type).toBe('document');
    expect(plainText).toBe('Done.');
  });

  it('returns empty refs for plain text', () => {
    const text = 'No media here.';
    const { refs, plainText } = parseMediaReferences(text);
    expect(refs).toHaveLength(0);
    expect(plainText).toBe('No media here.');
  });
});
