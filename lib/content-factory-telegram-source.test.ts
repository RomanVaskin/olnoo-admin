import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeTelegramHandle,
  telegramPreviewUrl,
  parseTelegramPreviewHtml,
  fetchPublicTelegramChannel,
  ContentFactoryTelegramSourceError,
} from './content-factory-telegram-source.ts'

test('normalizeTelegramHandle: accepts a bare handle, an @handle, and a t.me URL', () => {
  assert.equal(normalizeTelegramHandle('alexander_realty'), 'alexander_realty')
  assert.equal(normalizeTelegramHandle('@alexander_realty'), 'alexander_realty')
  assert.equal(normalizeTelegramHandle('https://t.me/alexander_realty'), 'alexander_realty')
  assert.equal(normalizeTelegramHandle('https://t.me/s/alexander_realty'), 'alexander_realty')
  assert.equal(normalizeTelegramHandle('t.me/alexander_realty/123'), 'alexander_realty')
})

test('normalizeTelegramHandle: rejects an empty or malformed handle', () => {
  assert.equal(normalizeTelegramHandle(''), null)
  assert.equal(normalizeTelegramHandle('   '), null)
  assert.equal(normalizeTelegramHandle('a'), null)
  assert.equal(normalizeTelegramHandle('has a space'), null)
})

test('telegramPreviewUrl builds the public preview URL', () => {
  assert.equal(telegramPreviewUrl('alexander_realty'), 'https://t.me/s/alexander_realty')
})

function fixtureBlock(opts: { id: number; text: string; photoUrl?: string; datetime?: string }): string {
  const photo = opts.photoUrl
    ? `<a class="tgme_widget_message_photo_wrap" style="background-image:url('${opts.photoUrl}')" href="x"></a>`
    : ''
  return `<div class="tgme_widget_message_wrap js-widget_message_wrap">
    <div class="tgme_widget_message" data-post="alexander_realty/${opts.id}">
      ${photo}
      <div class="tgme_widget_message_text js-message_text" dir="auto">${opts.text}</div>
      <time class="time" datetime="${opts.datetime ?? '2026-01-01T10:00:00+00:00'}">10:00</time>
    </div>
  </div>`
}

test('parseTelegramPreviewHtml: extracts text, image, date, and builds a stable external id + URL', () => {
  const html = fixtureBlock({ id: 101, text: 'Новая вилла на побережье Аланьи.', photoUrl: 'https://cdn.example/x.jpg' })
  const messages = parseTelegramPreviewHtml(html, 'alexander_realty')
  assert.equal(messages.length, 1)
  assert.equal(messages[0].externalId, '101')
  assert.equal(messages[0].url, 'https://t.me/alexander_realty/101')
  assert.equal(messages[0].text, 'Новая вилла на побережье Аланьи.')
  assert.deepEqual(messages[0].imageUrls, ['https://cdn.example/x.jpg'])
  assert.equal(messages[0].publishedAt, '2026-01-01T10:00:00+00:00')
})

test('parseTelegramPreviewHtml: decodes HTML entities and converts <br> to newlines', () => {
  const html = fixtureBlock({ id: 102, text: 'Цена&nbsp;&mdash; от $200k.<br>Подробности &gt; здесь.' })
  const messages = parseTelegramPreviewHtml(html, 'alexander_realty')
  assert.equal(messages.length, 1)
  assert.ok(messages[0].text.includes('\n'))
  assert.ok(!messages[0].text.includes('&nbsp;'))
  assert.ok(messages[0].text.includes('>'))
})

test('parseTelegramPreviewHtml: skips a block with neither text nor an image (service/forward marker)', () => {
  const html = `<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="alexander_realty/103"></div></div>`
  const messages = parseTelegramPreviewHtml(html, 'alexander_realty')
  assert.equal(messages.length, 0)
})

test('parseTelegramPreviewHtml: parses multiple messages from one page, in document order', () => {
  const html = fixtureBlock({ id: 201, text: 'First.' }) + fixtureBlock({ id: 202, text: 'Second.' })
  const messages = parseTelegramPreviewHtml(html, 'alexander_realty')
  assert.equal(messages.length, 2)
  assert.deepEqual(messages.map((m) => m.externalId), ['201', '202'])
})

test('fetchPublicTelegramChannel: throws a clear error when the preview HTTP request fails', async () => {
  await assert.rejects(
    () => fetchPublicTelegramChannel('private_channel', async () => ({ ok: false, status: 404, text: async () => '' })),
    ContentFactoryTelegramSourceError,
  )
})

test('fetchPublicTelegramChannel: throws a clear error when the response is not a Telegram preview page', async () => {
  await assert.rejects(
    () => fetchPublicTelegramChannel('not_a_channel', async () => ({ ok: true, status: 200, text: async () => '<html>nope</html>' })),
    ContentFactoryTelegramSourceError,
  )
})

test('fetchPublicTelegramChannel: throws a clear error when the network request itself fails', async () => {
  await assert.rejects(
    () =>
      fetchPublicTelegramChannel('alexander_realty', async () => {
        throw new Error('network down')
      }),
    ContentFactoryTelegramSourceError,
  )
})

test('fetchPublicTelegramChannel: returns the parsed messages for a reachable public channel', async () => {
  const html = fixtureBlock({ id: 301, text: 'Real post.' })
  const messages = await fetchPublicTelegramChannel('alexander_realty', async () => ({ ok: true, status: 200, text: async () => html }))
  assert.equal(messages.length, 1)
  assert.equal(messages[0].externalId, '301')
})
