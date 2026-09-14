import { Jimp } from 'jimp'

// Instagram Content Publishing API's documented image spec for Feed posts (developers.facebook.com
// /docs/instagram-platform/content-publishing/ — confirmed current, not guessed): aspect ratio must
// be between 4:5 (portrait) and 1.91:1 (landscape) inclusive, and width must be at most 1440px
// (Instagram's own servers scale a smaller width up, but a too-large width was observed in
// production to fail to publish rather than being scaled down server-side, so this handles the
// max-width side itself).
//
// Never crops: an out-of-range image is scaled down as a whole (proportionally, no distortion) to
// fit entirely inside a white canvas at the nearer valid ratio edge, then centered — the same
// "contain" behavior as CSS object-fit: contain, not object-fit: cover. Losing part of the user's
// photo to an automatic crop was the wrong UX; letterboxing with white keeps the whole frame.

export const INSTAGRAM_FEED_MIN_RATIO = 4 / 5
export const INSTAGRAM_FEED_MAX_RATIO = 1.91
export const INSTAGRAM_FEED_MAX_WIDTH = 1440

export function isInstagramFeedRatioAllowed(width: number, height: number): boolean {
  if (width <= 0 || height <= 0) return false
  const ratio = width / height
  return ratio >= INSTAGRAM_FEED_MIN_RATIO && ratio <= INSTAGRAM_FEED_MAX_RATIO
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

export type ContainLayout = {
  /** Final white-background canvas size — already <= INSTAGRAM_FEED_MAX_WIDTH wide and at the
   * nearer valid ratio edge (4:5 or 1.91:1). */
  canvasWidth: number
  canvasHeight: number
  /** The (possibly proportionally downscaled, never upscaled, never cropped) size to draw the
   * original image at before centering it on the canvas. */
  imageWidth: number
  imageHeight: number
  /** Top-left position to place the resized image at so it's centered on the canvas. */
  x: number
  y: number
}

/**
 * Pure geometry for an out-of-range image: the smallest canvas, at the nearer valid Feed ratio
 * (4:5 for too-tall, 1.91:1 for too-wide) and capped at INSTAGRAM_FEED_MAX_WIDTH wide, that the
 * entire original image fits inside without any cropping — plus where to center it. Returns null
 * if the image's ratio is already valid (nothing to pad; see computeInstagramFeedResize for the
 * separate width-only cap that still applies in that case).
 *
 * Algorithm ("contain", not "cover"): first size a canvas at the target ratio that exactly
 * contains the image at its native size (matching the image's own width when the image is wider
 * than the target ratio — padding added top/bottom; matching its own height when the image is
 * narrower/taller than the target ratio — padding added left/right). If that natural canvas is
 * wider than the 1440px cap, scale the canvas *and* the image down together by the same factor, so
 * the image still exactly fits with the same padding proportions. The image itself is only ever
 * scaled down (never up) and never cropped.
 */
export function computeInstagramFeedContain(width: number, height: number): ContainLayout | null {
  if (isInstagramFeedRatioAllowed(width, height)) return null

  const ratio = width / height
  const targetRatio = ratio > INSTAGRAM_FEED_MAX_RATIO ? INSTAGRAM_FEED_MAX_RATIO : INSTAGRAM_FEED_MIN_RATIO

  let canvasWidth: number
  let canvasHeight: number
  if (ratio > targetRatio) {
    // Too wide: the image's own width already exactly spans the canvas; the canvas grows taller
    // than the image to reach the target ratio (padding lands top/bottom).
    canvasWidth = width
    canvasHeight = Math.max(1, Math.round(width / targetRatio))
  } else {
    // Too tall: the image's own height already exactly spans the canvas; the canvas grows wider
    // than the image to reach the target ratio (padding lands left/right).
    canvasHeight = height
    canvasWidth = Math.max(1, Math.round(height * targetRatio))
  }

  let imageWidth = width
  let imageHeight = height
  if (canvasWidth > INSTAGRAM_FEED_MAX_WIDTH) {
    const scale = INSTAGRAM_FEED_MAX_WIDTH / canvasWidth
    canvasWidth = INSTAGRAM_FEED_MAX_WIDTH
    canvasHeight = Math.max(1, Math.round(canvasHeight * scale))
    imageWidth = Math.max(1, Math.round(imageWidth * scale))
    imageHeight = Math.max(1, Math.round(imageHeight * scale))
  }

  const x = Math.floor((canvasWidth - imageWidth) / 2)
  const y = Math.floor((canvasHeight - imageHeight) / 2)

  return { canvasWidth, canvasHeight, imageWidth, imageHeight, x, y }
}

/**
 * Decodes a JPEG buffer and makes it safe to publish to Instagram Feed without ever cropping any
 * of it out:
 * - if the aspect ratio is already valid (4:5–1.91:1), the whole frame is kept; only a
 *   proportional resize is applied if the width still exceeds 1440px (computeInstagramFeedResize);
 * - if the ratio is out of range, the whole image is proportionally scaled down (never distorted,
 *   never upscaled) to fit entirely inside a white canvas at the nearer valid ratio edge, capped
 *   at 1440px wide, and centered — the missing space is filled with white
 *   (computeInstagramFeedContain).
 * An image needing neither step returns its original bytes completely unchanged — no re-encode, no
 * quality loss, no behavior change for the common case. Throws if the buffer isn't a decodable
 * image (the caller — the upload route — already checked the JPEG magic bytes first; this is the
 * second, stricter layer that would also catch a corrupt file that merely starts with the right
 * bytes).
 */
export async function normalizeInstagramImageBuffer(buffer: Buffer): Promise<Buffer> {
  const image = await Jimp.fromBuffer(buffer)

  const contain = computeInstagramFeedContain(image.width, image.height)
  if (contain) {
    if (contain.imageWidth !== image.width || contain.imageHeight !== image.height) {
      image.resize({ w: contain.imageWidth, h: contain.imageHeight })
    }
    const canvas = new Jimp({ width: contain.canvasWidth, height: contain.canvasHeight, color: 0xffffffff })
    canvas.blit({ src: image, x: contain.x, y: contain.y })
    return canvas.getBuffer('image/jpeg', { quality: 92 })
  }

  const resize = computeInstagramFeedResize(image.width, image.height)
  if (resize) {
    image.resize({ w: resize.w, h: resize.h })
    return image.getBuffer('image/jpeg', { quality: 92 })
  }

  return buffer
}
