import { Jimp } from 'jimp'

// Instagram Content Publishing API's documented image spec for Feed posts (developers.facebook.com
// /docs/instagram-platform/content-publishing/ — confirmed current, not guessed): aspect ratio must
// be between 4:5 (portrait) and 1.91:1 (landscape) inclusive; width is auto-scaled by Instagram's
// own servers outside 320–1440px, so this only needs to fix ratio, not width. Publishing an image
// outside that ratio range is exactly the "The aspect ratio is not supported." failure this file
// exists to prevent at upload time, before the file ever reaches lib/social-instagram.ts.

export const INSTAGRAM_FEED_MIN_RATIO = 4 / 5
export const INSTAGRAM_FEED_MAX_RATIO = 1.91
// Preferred normalized target for an out-of-range image (per product decision — a single fixed
// target keeps this a one-formula normalization instead of two, and 4:5 is Instagram's own
// recommended/most-space-efficient Feed ratio). A very wide source (e.g. a panorama) is cropped
// down to 4:5 too, not just to the nearer 1.91:1 edge — more aggressive than the bare minimum for
// that case, but simpler and still always inside the accepted range.
export const INSTAGRAM_FEED_TARGET_RATIO = 4 / 5

export type CropRect = { x: number; y: number; w: number; h: number }

export function isInstagramFeedRatioAllowed(width: number, height: number): boolean {
  if (width <= 0 || height <= 0) return false
  const ratio = width / height
  return ratio >= INSTAGRAM_FEED_MIN_RATIO && ratio <= INSTAGRAM_FEED_MAX_RATIO
}

/**
 * Pure geometry: the centered crop rectangle that brings an out-of-range image to exactly 4:5, or
 * null if the image's ratio is already within Instagram Feed's accepted 4:5–1.91:1 range (nothing
 * to crop — the caller should keep the original bytes as-is, not re-encode them). Never upscales;
 * only ever crops within the source's existing width/height, so there is no quality loss beyond
 * the crop itself (no resampling/distortion).
 */
export function computeInstagramFeedCrop(width: number, height: number): CropRect | null {
  if (isInstagramFeedRatioAllowed(width, height)) return null

  const ratio = width / height
  if (ratio > INSTAGRAM_FEED_TARGET_RATIO) {
    // Too wide relative to the target: crop width down, height unchanged.
    const w = Math.max(1, Math.floor(height * INSTAGRAM_FEED_TARGET_RATIO))
    const x = Math.floor((width - w) / 2)
    return { x, y: 0, w, h: height }
  }
  // Too tall relative to the target: crop height down, width unchanged.
  const h = Math.max(1, Math.floor(width / INSTAGRAM_FEED_TARGET_RATIO))
  const y = Math.floor((height - h) / 2)
  return { x: 0, y, w: width, h }
}

/**
 * Decodes a JPEG buffer, and if its aspect ratio isn't already valid for Instagram Feed, returns a
 * centered-cropped (never stretched/distorted) JPEG buffer at exactly 4:5 instead. An
 * already-valid image's original bytes are returned completely unchanged — no re-encode, no
 * quality loss, no behavior change for the common case. Throws if the buffer isn't a decodable
 * image (the caller — the upload route — already checked the JPEG magic bytes first; this is the
 * second, stricter layer that would also catch a corrupt file that merely starts with the right
 * bytes).
 */
export async function normalizeInstagramImageBuffer(buffer: Buffer): Promise<Buffer> {
  const image = await Jimp.fromBuffer(buffer)
  const crop = computeInstagramFeedCrop(image.width, image.height)
  if (!crop) return buffer

  const cropped = image.crop({ x: crop.x, y: crop.y, w: crop.w, h: crop.h })
  return cropped.getBuffer('image/jpeg', { quality: 92 })
}
