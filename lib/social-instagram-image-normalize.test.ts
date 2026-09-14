import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Jimp } from 'jimp'
import {
  isInstagramFeedRatioAllowed,
  computeInstagramFeedCrop,
  computeInstagramFeedResize,
  normalizeInstagramImageBuffer,
  INSTAGRAM_FEED_MIN_RATIO,
  INSTAGRAM_FEED_MAX_RATIO,
  INSTAGRAM_FEED_MAX_WIDTH,
} from './social-instagram-image-normalize.ts'

test('a 1:1 square is already allowed', () => {
  assert.equal(isInstagramFeedRatioAllowed(1000, 1000), true)
  assert.equal(computeInstagramFeedCrop(1000, 1000), null)
})

test('a landscape within 1.91:1 is already allowed', () => {
  assert.equal(isInstagramFeedRatioAllowed(1910, 1000), true)
  assert.equal(computeInstagramFeedCrop(1910, 1000), null)
})

test('a portrait within 4:5 is already allowed', () => {
  assert.equal(isInstagramFeedRatioAllowed(800, 1000), true)
  assert.equal(computeInstagramFeedCrop(800, 1000), null)
})

test('exactly the 1.91:1 boundary is allowed (inclusive)', () => {
  assert.equal(isInstagramFeedRatioAllowed(1910000, 1000000), true)
})

test('exactly the 4:5 boundary is allowed (inclusive)', () => {
  assert.equal(isInstagramFeedRatioAllowed(4000, 5000), true)
})

test('a too-tall portrait is cropped to exactly 4:5, centered on height', () => {
  // 1000x2000 -> ratio 0.5, below the 0.8 minimum
  assert.equal(isInstagramFeedRatioAllowed(1000, 2000), false)
  const crop = computeInstagramFeedCrop(1000, 2000)
  assert.ok(crop)
  assert.equal(crop!.w, 1000) // width untouched
  assert.equal(crop!.h, 1250) // 1000 / (4/5) = 1250
  assert.equal(crop!.x, 0)
  assert.equal(crop!.y, 375) // (2000 - 1250) / 2
  assert.equal(crop!.w / crop!.h, 0.8)
})

test('a too-wide landscape is cropped to exactly 1.91:1, centered on width', () => {
  // 3000x1000 -> ratio 3.0, above the 1.91 maximum
  assert.equal(isInstagramFeedRatioAllowed(3000, 1000), false)
  const crop = computeInstagramFeedCrop(3000, 1000)
  assert.ok(crop)
  assert.equal(crop!.h, 1000) // height untouched
  assert.equal(crop!.w, 1910) // 1000 * 1.91 = 1910
  assert.equal(crop!.y, 0)
  assert.equal(crop!.x, 545) // (3000 - 1910) / 2
  assert.equal(crop!.w / crop!.h, 1.91)
})

test('a landscape just past the 1.91:1 boundary is cropped to the 1.91:1 edge, not 4:5', () => {
  assert.equal(isInstagramFeedRatioAllowed(2000, 1000), false) // ratio 2.0 > 1.91
  const crop = computeInstagramFeedCrop(2000, 1000)
  assert.ok(crop)
  assert.equal(crop!.w / crop!.h, 1.91)
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

test('normalizeInstagramImageBuffer returns the original bytes unchanged when already valid', async () => {
  const image = new Jimp({ width: 1000, height: 1000, color: 0x336699ff })
  const original = await image.getBuffer('image/jpeg')
  const result = await normalizeInstagramImageBuffer(original)
  assert.ok(result.equals(original))
})

test('normalizeInstagramImageBuffer crops a 1000x2200 too-tall portrait to 4:5, no unnecessary resize', async () => {
  const image = new Jimp({ width: 1000, height: 2200, color: 0x336699ff })
  const original = await image.getBuffer('image/jpeg')
  const result = await normalizeInstagramImageBuffer(original)
  assert.ok(!result.equals(original))
  assert.equal(result[0], 0xff)
  assert.equal(result[1], 0xd8)
  assert.equal(result[2], 0xff)
  const reloaded = await Jimp.fromBuffer(result)
  assert.equal(isInstagramFeedRatioAllowed(reloaded.width, reloaded.height), true)
  assert.ok(reloaded.width <= INSTAGRAM_FEED_MAX_WIDTH)
  // Width (1000) never needed a resize (well under the 1440 cap) — cropping to 4:5 fully explains
  // the result on its own, height (1250) is not further scaled down.
  assert.equal(reloaded.width, 1000)
  assert.equal(reloaded.height, 1250)
})

test('normalizeInstagramImageBuffer crops a 3200x900 too-wide landscape to 1.91:1, then resizes to fit width 1440', async () => {
  const image = new Jimp({ width: 3200, height: 900, color: 0x336699ff })
  const original = await image.getBuffer('image/jpeg')
  const result = await normalizeInstagramImageBuffer(original)
  assert.ok(!result.equals(original))
  const reloaded = await Jimp.fromBuffer(result)
  assert.equal(isInstagramFeedRatioAllowed(reloaded.width, reloaded.height), true)
  assert.ok(reloaded.width <= INSTAGRAM_FEED_MAX_WIDTH)
  // Cropping 3200x900 to 1.91:1 alone would give 1719x900 — still over the 1440 width cap, so the
  // resize step must also fire on top of the crop.
  assert.equal(reloaded.width, 1440)
  assert.equal(reloaded.height, 754)
})

test('normalizeInstagramImageBuffer resizes a large but already-valid-ratio 6000x4000 image to width 1440', async () => {
  const image = new Jimp({ width: 6000, height: 4000, color: 0x336699ff }) // ratio 1.5, already valid
  const original = await image.getBuffer('image/jpeg')
  const result = await normalizeInstagramImageBuffer(original)
  assert.ok(!result.equals(original))
  const reloaded = await Jimp.fromBuffer(result)
  assert.equal(isInstagramFeedRatioAllowed(reloaded.width, reloaded.height), true)
  assert.equal(reloaded.width, INSTAGRAM_FEED_MAX_WIDTH)
  assert.equal(reloaded.width, 1440)
  assert.equal(reloaded.height, 960)
})

test('normalizeInstagramImageBuffer leaves a 1200x1200 image (valid ratio, width under the cap) completely unchanged', async () => {
  const image = new Jimp({ width: 1200, height: 1200, color: 0x336699ff })
  const original = await image.getBuffer('image/jpeg')
  const result = await normalizeInstagramImageBuffer(original)
  assert.ok(result.equals(original))
})

test('normalizeInstagramImageBuffer resizes an already-valid-ratio landscape whose width exceeds the cap', async () => {
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
