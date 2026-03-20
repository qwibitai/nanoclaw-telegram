/**
 * Telegram media download and processing utilities.
 * Downloads photos and documents from Telegram Bot API and saves them
 * to the group's attachments directory for agent access.
 */
import fs from 'fs';
import https from 'https';
import path from 'path';

import { logger } from './logger.js';

interface PhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** Maximum dimension for photos sent to Claude's vision API. */
const MAX_PHOTO_DIMENSION = 1568;

/** Maximum file size for Telegram Bot API getFile (20MB). */
const MAX_TELEGRAM_FILE_SIZE = 20 * 1024 * 1024;

/**
 * Download a file from Telegram Bot API.
 * Uses getFile to get the file path, then fetches the binary content.
 */
export async function downloadTelegramFile(
  botToken: string,
  fileId: string,
): Promise<Buffer> {
  // Step 1: Get file path from Telegram
  const fileInfo = await fetchJson(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`,
  );
  if (!fileInfo.ok || !fileInfo.result?.file_path) {
    throw new Error(
      `Telegram getFile failed: ${fileInfo.description || 'unknown error'}`,
    );
  }

  // Step 2: Download file content
  const fileUrl = `https://api.telegram.org/file/bot${botToken}/${fileInfo.result.file_path}`;
  return fetchBuffer(fileUrl);
}

/**
 * Pick the best photo size from Telegram's PhotoSize array.
 * Returns the largest size where both dimensions are <= MAX_PHOTO_DIMENSION.
 * If all sizes exceed the limit, returns the smallest available.
 */
export function pickBestPhotoSize(photoSizes: PhotoSize[]): PhotoSize {
  if (photoSizes.length === 0) {
    throw new Error('No photo sizes available');
  }

  // Sort by area (largest first)
  const sorted = [...photoSizes].sort(
    (a, b) => b.width * b.height - a.width * a.height,
  );

  // Find largest that fits within Claude's recommended dimensions
  const fitting = sorted.find(
    (p) => p.width <= MAX_PHOTO_DIMENSION && p.height <= MAX_PHOTO_DIMENSION,
  );

  // If none fit, use the smallest available (Telegram always provides a small thumbnail)
  return fitting || sorted[sorted.length - 1];
}

/**
 * Download a Telegram photo and save it to the group's attachments directory.
 * Returns the relative path (e.g. "attachments/photo-42.jpg").
 */
export async function saveTelegramPhoto(
  botToken: string,
  photoSizes: PhotoSize[],
  groupDir: string,
  messageId: string,
): Promise<string> {
  const bestSize = pickBestPhotoSize(photoSizes);

  // Check file size if available (skip if too large for Telegram API)
  if (bestSize.file_size && bestSize.file_size > MAX_TELEGRAM_FILE_SIZE) {
    throw new Error(
      `Photo too large for Telegram API: ${bestSize.file_size} bytes`,
    );
  }

  const buffer = await downloadTelegramFile(botToken, bestSize.file_id);
  const filename = `photo-${messageId}.jpg`;
  const attachDir = ensureAttachmentsDir(groupDir);
  const filePath = path.join(attachDir, filename);

  fs.writeFileSync(filePath, buffer);
  logger.debug(
    { messageId, size: buffer.length, width: bestSize.width, height: bestSize.height },
    'Telegram photo saved',
  );

  return `attachments/${filename}`;
}

/**
 * Download a Telegram document and save it to the group's attachments directory.
 * Returns the relative path (e.g. "attachments/report.pdf").
 */
export async function saveTelegramDocument(
  botToken: string,
  document: TelegramDocument,
  groupDir: string,
  messageId: string,
): Promise<string> {
  // Check file size if available
  if (document.file_size && document.file_size > MAX_TELEGRAM_FILE_SIZE) {
    throw new Error(
      `Document too large for Telegram API: ${document.file_size} bytes`,
    );
  }

  const buffer = await downloadTelegramFile(botToken, document.file_id);
  const filename = sanitizeFilename(document.file_name, messageId);
  const attachDir = ensureAttachmentsDir(groupDir);
  const filePath = path.join(attachDir, filename);

  fs.writeFileSync(filePath, buffer);
  logger.debug(
    { messageId, filename, size: buffer.length, mimeType: document.mime_type },
    'Telegram document saved',
  );

  return `attachments/${filename}`;
}

/**
 * Sanitize a filename to prevent path traversal and ensure uniqueness.
 */
export function sanitizeFilename(
  originalName: string | undefined,
  messageId: string,
): string {
  if (!originalName) return `doc-${messageId}`;

  // Strip directory components and null bytes
  const base = path.basename(originalName).replace(/\0/g, '');

  // Limit length
  if (base.length > 200) {
    const ext = path.extname(base);
    return `${base.slice(0, 200 - ext.length)}${ext}`;
  }

  // Prefix with message ID to avoid collisions
  return `${messageId}-${base}`;
}

export interface MediaRef {
  type: 'photo' | 'document';
  relativePath: string;
}

/**
 * Extract media references from agent output text.
 * Returns the references and the text with references removed.
 */
export function parseMediaReferences(text: string): { refs: MediaRef[]; plainText: string } {
  const refs: MediaRef[] = [];
  const cleaned = text.replace(
    /\[(Photo|Document): (attachments\/[^\]]+)\]\n?/g,
    (_match, type, relPath) => {
      refs.push({
        type: type.toLowerCase() as 'photo' | 'document',
        relativePath: relPath,
      });
      return '';
    },
  );
  return { refs, plainText: cleaned.trim() };
}

/**
 * Ensure the attachments directory exists in the group folder.
 * Returns the absolute path to the attachments directory.
 */
export function ensureAttachmentsDir(groupDir: string): string {
  const attachDir = path.join(groupDir, 'attachments');
  fs.mkdirSync(attachDir, { recursive: true });
  return attachDir;
}

// --- HTTP helpers ---

/** HTTP request timeout in milliseconds (30 seconds). */
const HTTP_TIMEOUT_MS = 30_000;

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid JSON from Telegram API`));
          }
        });
      })
      .on('error', reject);
    req.setTimeout(HTTP_TIMEOUT_MS, () => {
      req.destroy(new Error(`Request timed out after ${HTTP_TIMEOUT_MS}ms`));
    });
  });
}

function fetchBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchBuffer(res.headers.location).then(resolve, reject);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} from Telegram file API`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .on('error', reject);
    req.setTimeout(HTTP_TIMEOUT_MS, () => {
      req.destroy(new Error(`Request timed out after ${HTTP_TIMEOUT_MS}ms`));
    });
  });
}
