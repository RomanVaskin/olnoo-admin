import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Jimp } from 'jimp'
import {
  isInstagramFeedRatioAllowed,
  computeInstagramFeedCrop,
  normalizeInstagramImageBuffer,
  INSTAGRAM_FEED_MIN_RATIO,
  INSTAGRAM_FEED_MAX_RATIO,
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

test('a too-wide landscape is cropped to exactly 4:5, centered on width', () => {
  // 3000x1000 -> ratio 3.0, above the 1.91 maximum
  assert.equal(isInstagramFeedRatioAllowed(3000, 1000), false)
  const crop = computeInstagramFeedCrop(3000, 1000)
  assert.ok(crop)
  assert.equal(crop!.h, 1000) // height untouched
  assert.equal(crop!.w, 800) // 1000 * (4/5) = 800
  assert.equal(crop!.y, 0)
  assert.equal(crop!.x, 1100) // (3000 - 800) / 2
  assert.equal(crop!.w / crop!.h, 0.8)
})

test('a landscape just past the 1.91:1 boundary is still cropped', () => {
  assert.equal(isInstagramFeedRatioAllowed(2000, 1000), false) // ratio 2.0 > 1.91
  const crop = computeInstagramFeedCrop(2000, 1000)
  assert.ok(crop)
  assert.equal(crop!.w / crop!.h, 0.8)
})

test('the documented constants match the official Instagram Feed range (4:5 to 1.91:1)', () => {
  assert.equal(INSTAGRAM_FEED_MIN_RATIO, 0.8)
  assert.equal(INSTAGRAM_FEED_MAX_RATIO, 1.91)
})

test('normalizeInstagramImageBuffer returns the original bytes unchanged when already valid', async () => {
  const image = new Jimp({ width: 1000, height: 1000, color: 0x336699ff })
  const original = await image.getBuffer('image/jpeg')
  const result = await normalizeInstagramImageBuffer(original)
  assert.ok(result.equals(original))
})

test('normalizeInstagramImageBuffer crops a too-tall portrait to a valid 4:5 JPEG', async () => {
  const image = new Jimp({ width: 1000, height: 2000, color: 0x336699ff })
  const original = await image.getBuffer('image/jpeg')
  const result = await normalizeInstagramImageBuffer(original)
  assert.ok(!result.equals(original))
  assert.equal(result[0], 0xff)
  assert.equal(result[1], 0xd8)
  assert.equal(result[2], 0xff)
  const reloaded = await Jimp.fromBuffer(result)
  assert.equal(isInstagramFeedRatioAllowed(reloaded.width, reloaded.height), true)
  assert.equal(reloaded.width, 1000)
  assert.equal(reloaded.height, 1250)
})

test('normalizeInstagramImageBuffer crops a too-wide landscape to a valid 4:5 JPEG', async () => {
  const image = new Jimp({ width: 3000, height: 1000, color: 0x336699ff })
  const original = await image.getBuffer('image/jpeg')
  const result = await normalizeInstagramImageBuffer(original)
  assert.ok(!result.equals(original))
  const reloaded = await Jimp.fromBuffer(result)
  assert.equal(isInstagramFeedRatioAllowed(reloaded.width, reloaded.height), true)
  assert.equal(reloaded.width, 800)
  assert.equal(reloaded.height, 1000)
})

test('normalizeInstagramImageBuffer leaves an already-valid landscape unchanged', async () => {
  const image = new Jimp({ width: 1600, height: 900, color: 0x336699ff }) // ratio ~1.78, within range
  const original = await image.getBuffer('image/jpeg')
  const result = await normalizeInstagramImageBuffer(original)
  assert.ok(result.equals(original))
})

test('normalizeInstagramImageBuffer rejects a buffer that is not a decodable image', async () => {
  await assert.rejects(() => normalizeInstagramImageBuffer(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02])))
})
