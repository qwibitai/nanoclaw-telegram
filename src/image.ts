/**
 * Image processing for multimodal vision.
 *
 * Channels download images to a group's `attachments/` directory and call
 * `processImageFile()` to resize+normalize them. The resulting marker
 * `[Image: attachments/img-...jpg]` is then embedded in the message content,
 * which `parseImageReferences()` later extracts so the agent-runner can
 * load and base64-encode the bytes for the Claude SDK as a multimodal block.
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const MAX_DIMENSION = 1024;
const IMAGE_REF_PATTERN = /\[Image: (attachments\/[^\]]+)\]/g;

export interface ProcessedImage {
  /** The marker to embed in the message content (e.g. "[Image: attachments/img-X.jpg]"). */
  marker: string;
  /** Group-relative path of the resized JPEG (e.g. "attachments/img-X.jpg"). */
  relativePath: string;
}

export interface ImageAttachment {
  relativePath: string;
  mediaType: string;
}

/**
 * Process an image that's already been downloaded to disk.
 * Resizes (max 1024px on the longest edge), re-encodes as JPEG quality 85,
 * writes to `attachments/img-<ts>-<rnd>.jpg`, deletes the original if requested,
 * and returns the marker + relative path.
 */
export async function processImageFile(
  sourcePath: string,
  groupDir: string,
  options: { caption?: string; deleteSource?: boolean } = {},
): Promise<ProcessedImage | null> {
  if (!fs.existsSync(sourcePath)) return null;

  const buffer = fs.readFileSync(sourcePath);
  if (buffer.length === 0) return null;

  const resized = await sharp(buffer)
    .rotate() // honor EXIF orientation, then strip it
    .resize(MAX_DIMENSION, MAX_DIMENSION, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 85 })
    .toBuffer();

  const attachDir = path.join(groupDir, 'attachments');
  fs.mkdirSync(attachDir, { recursive: true });

  const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`;
  const filePath = path.join(attachDir, filename);
  fs.writeFileSync(filePath, resized);

  if (options.deleteSource && sourcePath !== filePath) {
    try {
      fs.unlinkSync(sourcePath);
    } catch {
      // best-effort cleanup
    }
  }

  const relativePath = `attachments/${filename}`;
  const caption = options.caption?.trim();
  const marker = caption
    ? `[Image: ${relativePath}] ${caption}`
    : `[Image: ${relativePath}]`;

  return { marker, relativePath };
}

/**
 * Scan message content for `[Image: attachments/...]` markers and return
 * the referenced images so the agent-runner can load + base64 + push as
 * multimodal content blocks.
 */
export function parseImageReferences(
  messages: Array<{ content: string }>,
): ImageAttachment[] {
  const refs: ImageAttachment[] = [];
  const seen = new Set<string>();
  for (const msg of messages) {
    let match: RegExpExecArray | null;
    IMAGE_REF_PATTERN.lastIndex = 0;
    while ((match = IMAGE_REF_PATTERN.exec(msg.content)) !== null) {
      const rel = match[1];
      if (seen.has(rel)) continue;
      seen.add(rel);
      // processImageFile() always emits .jpg, so media_type is fixed.
      refs.push({ relativePath: rel, mediaType: 'image/jpeg' });
    }
  }
  return refs;
}
