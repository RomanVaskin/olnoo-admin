import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Jimp } from 'jimp'
import {
  isInstagramFeedRatioAllowed,
  computeInstagramFeedResize,
  computeInstagramFeedContain,
  normalizeInstagramImageBuffer,
  INSTAGRAM_FEED_MIN_RATIO,
  INSTAGRAM_FEED_MAX_RATIO,
  INSTAGRAM_FEED_MAX_WIDTH,
} from './social-instagram-image-normalize.ts'

// JPEG re-encoding is lossy: even a pixel drawn from a solid fill color can quantize a couple of
// levels off after compression/decompression. These checks care whether a pixel is (close to) the
// original fill vs. white padding, not bit-exactness, so allow a small tolerance.
function assertCloseToColor(px: Buffer | Uint8Array, [r, g, b]: [number, number, number]) {
  assert.ok(Math.abs(px[0] - r) <= 8, `red channel ${px[0]} not close to ${r}`)
  assert.ok(Math.abs(px[1] - g) <= 8, `green channel ${px[1]} not close to ${g}`)
  assert.ok(Math.abs(px[2] - b) <= 8, `blue channel ${px[2]} not close to ${b}`)
}

test('a 1:1 square is already allowed', () => {
  assert.equal(isInstagramFeedRatioAllowed(1000, 1000), true)
  assert.equal(computeInstagramFeedContain(1000, 1000), null)
})

test('a landscape within 1.91:1 is already allowed', () => {
  assert.equal(isInstagramFeedRatioAllowed(1910, 1000), true)
  assert.equal(computeInstagramFeedContain(1910, 1000), null)
})

test('a portrait within 4:5 is already allowed', () => {
  assert.equal(isInstagramFeedRatioAllowed(800, 1000), true)
  assert.equal(computeInstagramFeedContain(800, 1000), null)
})

test('exactly the 1.91:1 boundary is allowed (inclusive)', () => {
  assert.equal(isInstagramFeedRatioAllowed(1910000, 1000000), true)
})

test('exactly the 4:5 boundary is allowed (inclusive)', () => {
  assert.equal(isInstagramFeedRatioAllowed(4000, 5000), true)
})

test('the documented constants match the official Instagram Feed range (4:5 to 1.91:1) and max width', () => {
  assert.equal(INSTAGRAM_FEED_MIN_RATIO, 0.8)
  assert.equal(INSTAGRAM_FEED_MAX_RATIO, 1.91)
  assert.equal(INSTAGRAM_FEED_MAX_WIDTH, 1440)
})

test('computeInstagramFeedResize is null when width is already within the max', () => {
  assert.equal(computeInstagramFeedResize(1440, 1000), null)
  assert.equal(computeInstagramFeedResize(1000, 1000), null)
})

test('computeInstagramFeedResize scales width down to 1440 proportionally, no distortion', () => {
  // 6000x4000 -> ratio 1.5 (already valid), just too wide in pixels
  const resize = computeInstagramFeedResize(6000, 4000)
  assert.ok(resize)
  assert.equal(resize!.w, 1440)
  assert.equal(resize!.h, 960) // 4000 * (1440/6000) = 960, ratio preserved exactly
  assert.equal(resize!.w / resize!.h, 6000 / 4000)
})

test('computeInstagramFeedContain pads a too-wide 3200x900 image top/bottom, no crop, canvas <= 1440 wide', () => {
  // ratio 3.556 > 1.91 -> target 1.91:1. Natural canvas 3200x1675, over the 1440 cap, so canvas
  // and image both scale down by 1440/3200 together.
  const contain = computeInstagramFeedContain(3200, 900)
  assert.ok(contain)
  assert.equal(contain!.canvasWidth, 1440)
  assert.equal(contain!.canvasHeight, 754) // round(1675 * 1440/3200)
  assert.equal(contain!.imageWidth, 1440) // round(3200 * 1440/3200)
  assert.equal(contain!.imageHeight, 405) // round(900 * 1440/3200) — the WHOLE original frame, just smaller
  assert.equal(contain!.x, 0) // image spans the full canvas width — no left/right crop or gap
  assert.equal(contain!.y, 174) // (754 - 405) / 2, centered — this is the white padding, not a crop
  assert.equal(isInstagramFeedRatioAllowed(contain!.canvasWidth, contain!.canvasHeight), true)
  assert.ok(contain!.canvasWidth <= INSTAGRAM_FEED_MAX_WIDTH)
})

test('computeInstagramFeedContain pads a too-tall 1000x2200 image left/right, no crop, canvas ratio 4:5', () => {
  // ratio 0.4545 < 0.8 -> target 4:5. Natural canvas 1760x2200, over the 1440 cap, so canvas and
  // image both scale down by 1440/1760 together.
  const contain = computeInstagramFeedContain(1000, 2200)
  assert.ok(contain)
  assert.equal(contain!.canvasWidth, 1440)
  assert.equal(contain!.canvasHeight, 1800) // round(2200 * 1440/1760)
  assert.equal(contain!.imageWidth, 818) // round(1000 * 1440/1760) — the WHOLE original frame, just smaller
  assert.equal(contain!.imageHeight, 1800) // round(2200 * 1440/1760) — matches canvas height exactly
  assert.equal(contain!.y, 0) // image spans the full canvas height — no top/bottom crop or gap
  assert.equal(contain!.x, 311) // (1440 - 818) / 2, centered — this is the white padding, not a crop
  assert.equal(contain!.canvasWidth / contain!.canvasHeight, 0.8)
  assert.equal(isInstagramFeedRatioAllowed(contain!.canvasWidth, contain!.canvasHeight), true)
})

test('computeInstagramFeedContain never upscales a small out-of-range image (canvas already under the cap)', () => {
  // 1000x300 -> ratio 3.333 > 1.91, but the natural canvas (1000x524) is already under 1440, so no
  // scaling of the image or canvas happens at all.
  const contain = computeInstagramFeedContain(1000, 300)
  assert.ok(contain)
  assert.equal(contain!.imageWidth, 1000) // unscaled — the original image pixels, untouched
  assert.equal(contain!.imageHeight, 300)
  assert.equal(contain!.canvasWidth, 1000)
  assert.ok(contain!.canvasWidth <= INSTAGRAM_FEED_MAX_WIDTH)
})

test('normalizeInstagramImageBuffer returns the original bytes unchanged when already valid and under the width cap', async () => {
  const image = new Jimp({ width: 1000, height: 1000, color: 0x336699ff })
  const original = await image.getBuffer('image/jpeg')
  const result = await normalizeInstagramImageBuffer(original)
  assert.ok(result.equals(original))
})

test('normalizeInstagramImageBuffer leaves a 1200x1200 image completely unchanged', async () => {
  const image = new Jimp({ width: 1200, height: 1200, color: 0x336699ff })
  const original = await image.getBuffer('image/jpeg')
  const result = await normalizeInstagramImageBuffer(original)
  assert.ok(result.equals(original))
})

test('normalizeInstagramImageBuffer resizes a large but already-valid-ratio 6000x4000 image, no canvas/padding', async () => {
  const image = new Jimp({ width: 6000, height: 4000, color: 0x336699ff }) // ratio 1.5, already valid
  const original = await image.getBuffer('image/jpeg')
  const result = await normalizeInstagramImageBuffer(original)
  assert.ok(!result.equals(original))
  const reloaded = await Jimp.fromBuffer(result)
  assert.equal(isInstagramFeedRatioAllowed(reloaded.width, reloaded.height), true)
  assert.ok(reloaded.width <= INSTAGRAM_FEED_MAX_WIDTH)
  assert.equal(reloaded.width, 1440)
  assert.equal(reloaded.height, 960)
  // Pure proportional resize, not a contain/pad: no white border introduced — every pixel along
  // the resized image's own edge should still be the original solid fill color, not white.
  const px = reloaded.bitmap.data.subarray(0, 4)
  assertCloseToColor(px, [0x33, 0x66, 0x99])
})

test('normalizeInstagramImageBuffer keeps the entire 3200x900 too-wide frame, letterboxed on white, no crop', async () => {
  const image = new Jimp({ width: 3200, height: 900, color: 0x336699ff })
  const original = await image.getBuffer('image/jpeg')
  const result = await normalizeInstagramImageBuffer(original)
  assert.ok(!result.equals(original))
  const reloaded = await Jimp.fromBuffer(result)
  assert.equal(isInstagramFeedRatioAllowed(reloaded.width, reloaded.height), true)
  assert.ok(reloaded.width <= INSTAGRAM_FEED_MAX_WIDTH)
  assert.equal(reloaded.width, 1440)
  assert.equal(reloaded.height, 754)
  // Top edge (center column) must be white padding, not cropped-away original content.
  const topPx = reloaded.bitmap.data.subarray((720) * 4, (720) * 4 + 4) // row 0, x=720 (center)
  assert.equal(topPx[0], 0xff)
  assert.equal(topPx[1], 0xff)
  assert.equal(topPx[2], 0xff)
  // Vertical center (where the original frame was placed) must show the original color, i.e. the
  // whole original frame is present, not cropped out.
  const centerY = Math.floor(754 / 2)
  const centerIdx = (centerY * 1440 + 720) * 4
  const centerPx = reloaded.bitmap.data.subarray(centerIdx, centerIdx + 4)
  assertCloseToColor(centerPx, [0x33, 0x66, 0x99])
})

test('normalizeInstagramImageBuffer keeps the entire 1000x2200 too-tall frame, letterboxed on white, no crop', async () => {
  const image = new Jimp({ width: 1000, height: 2200, color: 0x336699ff })
  const original = await image.getBuffer('image/jpeg')
  const result = await normalizeInstagramImageBuffer(original)
  assert.ok(!result.equals(original))
  const reloaded = await Jimp.fromBuffer(result)
  assert.equal(isInstagramFeedRatioAllowed(reloaded.width, reloaded.height), true)
  assert.ok(reloaded.width <= INSTAGRAM_FEED_MAX_WIDTH)
  assert.equal(reloaded.width, 1440)
  assert.equal(reloaded.height, 1800)
  // Left edge (vertical center row) must be white padding, not cropped-away original content.
  const centerRow = Math.floor(1800 / 2)
  const leftIdx = (centerRow * 1440 + 0) * 4
  const leftPx = reloaded.bitmap.data.subarray(leftIdx, leftIdx + 4)
  assert.equal(leftPx[0], 0xff)
  assert.equal(leftPx[1], 0xff)
  assert.equal(leftPx[2], 0xff)
  // Horizontal center must show the original color — the whole original frame is present.
  const centerIdx = (centerRow * 1440 + 720) * 4
  const centerPx = reloaded.bitmap.data.subarray(centerIdx, centerIdx + 4)
  assertCloseToColor(centerPx, [0x33, 0x66, 0x99])
})

test('normalizeInstagramImageBuffer resizes an already-valid-ratio landscape whose width exceeds the cap, no padding', async () => {
  // ratio ~1.78 is already valid, but width 1600 > 1440 still needs a resize on its own.
  const image = new Jimp({ width: 1600, height: 900, color: 0x336699ff })
  const original = await image.getBuffer('image/jpeg')
  const result = await normalizeInstagramImageBuffer(original)
  assert.ok(!result.equals(original))
  const reloaded = await Jimp.fromBuffer(result)
  assert.equal(isInstagramFeedRatioAllowed(reloaded.width, reloaded.height), true)
  assert.equal(reloaded.width, 1440)
  assert.equal(reloaded.height, 810) // 900 * (1440/1600) = 810
})

test('normalizeInstagramImageBuffer rejects a buffer that is not a decodable image', async () => {
  await assert.rejects(() => normalizeInstagramImageBuffer(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02])))
})
