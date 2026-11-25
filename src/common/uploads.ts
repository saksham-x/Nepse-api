import { randomBytes } from 'node:crypto';
import { mkdirSync, openSync, readSync, closeSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { Response } from 'express';
import multer from 'multer';
import { env } from '../config/env.js';
import { AppError, ErrorCode } from './errors/app-error.js';

/**
 * Deposit screenshots and holding documents are stored on local disk under
 * UPLOAD_DIR with random names, and only served through authorized routes.
 */
const ROOT = path.resolve(env.UPLOAD_DIR);

const IMAGE_TYPES: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
const DOCUMENT_TYPES: Record<string, string> = {
  ...IMAGE_TYPES,
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
};

/** Leading bytes each accepted type must start with; the browser-sent MIME type alone isn't trusted. */
function sniff(file: string): string | null {
  const fd = openSync(file, 'r');
  const buf = Buffer.alloc(12);
  try {
    readSync(fd, buf, 0, 12, 0);
  } finally {
    closeSync(fd);
  }
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'zip';
  return null;
}

function uploader(folder: string, allowed: Record<string, string>) {
  const dir = path.join(ROOT, folder);
  mkdirSync(dir, { recursive: true });
  return multer({
    storage: multer.diskStorage({
      destination: dir,
      filename: (_req, file, cb) => cb(null, randomBytes(16).toString('hex') + (allowed[file.mimetype] ?? '')),
    }),
    limits: { fileSize: env.UPLOAD_MAX_MB * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => {
      if (allowed[file.mimetype]) cb(null, true);
      else cb(new AppError(400, ErrorCode.FILE_REJECTED, `Files of type ${file.mimetype} are not accepted`));
    },
  });
}

export const screenshotUpload = uploader('deposits', IMAGE_TYPES).single('screenshot');
export const documentUpload = uploader('documents', DOCUMENT_TYPES).single('file');

/** Checks an uploaded file's content matches its declared type; deletes it and throws if not. */
export function verifyUpload(file: Express.Multer.File): { storagePath: string; mime: string } {
  const detected = sniff(file.path);
  const zipType = file.mimetype.includes('openxmlformats');
  if (detected !== file.mimetype && !(detected === 'zip' && zipType)) {
    discardUpload(file.path);
    throw new AppError(400, ErrorCode.FILE_REJECTED, 'The file content does not match its type');
  }
  return { storagePath: path.relative(ROOT, file.path).split(path.sep).join('/'), mime: file.mimetype };
}

export function discardUpload(absolutePath: string): void {
  try {
    unlinkSync(absolutePath);
  } catch {
    // Already gone.
  }
}

export function removeStored(storagePath: string): void {
  discardUpload(path.join(ROOT, storagePath));
}

/** Streams a stored file. Images display inline; anything else downloads. */
export function sendStored(res: Response, storagePath: string, mime: string, downloadName?: string): void {
  const abs = path.resolve(ROOT, storagePath);
  if (!abs.startsWith(ROOT + path.sep)) throw new AppError(404, ErrorCode.NOT_FOUND, 'File not found');
  const inline = mime.startsWith('image/') || mime === 'application/pdf';
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${(downloadName ?? path.basename(abs)).replace(/["\\\r\n]/g, '_')}"`);
  res.sendFile(abs, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: { code: ErrorCode.NOT_FOUND, message: 'File not found' } });
  });
}
