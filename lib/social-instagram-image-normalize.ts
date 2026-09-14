import { Jimp } from 'jimp'

// Instagram Content Publishing API's documented image spec for Feed posts (developers.facebook.com
// /docs/instagram-platform/content-publishing/ — confirmed current, not guessed): aspect ratio must
// be between 4:5 (portrait) and 1.91:1 (landscape) inclusive, and width must be at most 1440px
// (Instagram's own servers scale a smaller width up, but a too-large width was observed to fail to
// publish rather than being scaled down server-side — so this handles the max-width side itself).
// Publishing an image outside the ratio range is the "The aspect ratio is not supported." failure
// this file exists to prevent at upload time, before the file ever reaches lib/social-instagram.ts;
// a too-wide-in-pixels image (valid ratio, e.g. 6000x4000) is the separate large-image failure this
// same file also now prevents.

export const INSTAGRAM_FEED_MIN_RATIO = 4 / 5
export const INSTAGRAM_FEED_MAX_RATIO = 1.91
export const INSTAGRAM_FEED_MAX_WIDTH = 1440

export type CropRect = { x: number; y: number; w: number; h: number }

export function isInstagramFeedRatioAllowed(width: number, height: number): boolean {
  if (width <= 0 || height <= 0) return false
  const ratio = width / height
  return ratio >= INSTAGRAM_FEED_MIN_RATIO && ratio <= INSTAGRAM_FEED_MAX_RATIO
}

/**
 * Pure geometry: the centered crop rectangle that brings an out-of-range image to the nearer edge
 * of Instagram Feed's accepted range — 4:5 for a too-tall portrait, 1.91:1 for a too-wide
 * landscape — or null if the image's ratio is already within that range (nothing to crop — the
 * caller should keep the original bytes as-is, not re-encode them). Cropping to the nearer edge
 * (rather than always 4:5) keeps as much of the original frame as the API allows — a wide
 * landscape no longer loses most of its width to reach a portrait target it was never close to.
 * Never upscales; only ever crops within the source's existing width/height, so there is no
 * quality loss beyond the crop itself (no resampling/distortion).
 */
export function computeInstagramFeedCrop(width: number, height: number): CropRect | null {
  if (isInstagramFeedRatioAllowed(width, height)) return null

  const ratio = width / height
  if (ratio > INSTAGRAM_FEED_MAX_RATIO) {
    // Too wide: crop width down to the 1.91:1 edge, height unchanged.
    const w = Math.max(1, Math.floor(height * INSTAGRAM_FEED_MAX_RATIO))
    const x = Math.floor((width - w) / 2)
    return { x, y: 0, w, h: height }
  }
  // Too tall (ratio < INSTAGRAM_FEED_MIN_RATIO): crop height down to the 4:5 edge, width unchanged.
  const h = Math.max(1, Math.floor(width / INSTAGRAM_FEED_MIN_RATIO))
  const y = Math.floor((height - h) / 2)
  return { x: 0, y, w: width, h }
}

/**
 * Pure geometry: the proportional {w,h} to resize down to when width exceeds
 * INSTAGRAM_FEED_MAX_WIDTH, or null if it's already within the limit (nothing to resize). Always
 * scales both dimensions by the same factor — never distorts — and only ever scales down (this is
 * only ever called with a width already over the cap, so it never upscales).
 */
export function computeInstagramFeedResize(width: number, height: number): { w: number; h: number } | null {
  if (width <= INSTAGRAM_FEED_MAX_WIDTH) return null
  const h = Math.max(1, Math.round((height / width) * INSTAGRAM_FEED_MAX_WIDTH))
  return { w: INSTAGRAM_FEED_MAX_WIDTH, h }
}

/**
 * Decodes a JPEG buffer and applies, in order: (1) a centered crop to the nearer valid edge if the
 * aspect ratio isn't already within Instagram Feed's accepted range (4:5 for too-tall, 1.91:1 for
 * too-wide — see computeInstagramFeedCrop; never stretched/distorted), then (2) a proportional
 * resize down to INSTAGRAM_FEED_MAX_WIDTH if the (possibly just-cropped) width still exceeds it
 * (see computeInstagramFeedResize — same aspect ratio, just smaller, never distorted). A large but
 * already-valid-ratio image (e.g. 6000x4000) hits only the resize step; an out-of-range image hits
 * both. An image that needs neither returns its original bytes completely unchanged — no
 * re-encode, no quality loss, no behavior change for the common case. Throws if the buffer isn't a
 * decodable image (the caller — the upload route — already checked the JPEG magic bytes first;
 * this is the second, stricter layer that would also catch a corrupt file that merely starts with
 * the right bytes).
 */
export async function normalizeInstagramImageBuffer(buffer: Buffer): Promise<Buffer> {
  const image = await Jimp.fromBuffer(buffer)
  let changed = false

  const crop = computeInstagramFeedCrop(image.width, image.height)
  if (crop) {
    image.crop({ x: crop.x, y: crop.y, w: crop.w, h: crop.h })
    changed = true
  }

  const resize = computeInstagramFeedResize(image.width, image.height)
  if (resize) {
    image.resize({ w: resize.w, h: resize.h })
    changed = true
  }

  if (!changed) return buffer
  return image.getBuffer('image/jpeg', { quality: 92 })
}
