// Image token detection and best-effort attachment reads, split out of
// hitl-pause.ts.

import { readFileSync } from "node:fs";
import type { RpcImage } from "./rpc-unit-client.ts";

/**
 * Guess an image mimeType from a file extension.
 *
 * @param path - The file path (or token) whose extension to inspect.
 * @returns The mimeType, or undefined for non-image extensions.
 */
export function imageMimeType(path: string): string | undefined {
  const ext = path.toLowerCase().split(".").pop();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return undefined;
  }
}

/**
 * Best-effort read of image file paths mentioned in a steer message.
 *
 * Whitespace-separated tokens with an image extension are read as base64
 * and attached; unreadable files are silently skipped (the text still
 * reaches the child either way).
 *
 * @param message - The steer message text.
 * @returns Attached images, possibly empty.
 */
export function readImageAttachments(message: string): RpcImage[] {
  const images: RpcImage[] = [];
  for (const token of message.split(/\s+/)) {
    const mimeType = imageMimeType(token);
    if (!mimeType) continue;
    try {
      const data = readFileSync(token).toString("base64");
      images.push({ type: "image", data, mimeType });
    } catch {
      // Unreadable path: skip; the message text still forwards.
    }
  }
  return images;
}
