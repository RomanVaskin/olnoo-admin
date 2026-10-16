import test from 'node:test'
import assert from 'node:assert/strict'
import { looksLikeMetaDescription } from './social-content-quality.ts'

test('requirement: catches the exact Russian meta-description phrasings named in the task', () => {
  assert.equal(looksLikeMetaDescription('Пост о том, как ИИ используется в бизнесе.'), true)
  assert.equal(looksLikeMetaDescription('Расскажем о том, как внедрить CRM в отделе продаж.'), true)
  assert.equal(looksLikeMetaDescription('Упор на преимущества керамического покрытия.'), true)
  assert.equal(looksLikeMetaDescription('Необходимо написать про уход за автомобилем зимой.'), true)
})

test('catches the English equivalents of the same defect', () => {
  assert.equal(looksLikeMetaDescription('This post is about how AI is used in business.'), true)
  assert.equal(looksLikeMetaDescription("We'll tell you about our new ceramic coating service."), true)
  assert.equal(looksLikeMetaDescription('A post about why winter tires matter.'), true)
  assert.equal(looksLikeMetaDescription("Here we'll focus on the benefits of regular detailing."), true)
})

test('is case-insensitive and tolerant of leading whitespace', () => {
  assert.equal(looksLikeMetaDescription('  ПОСТ О ТОМ, как ухаживать за кожей салона.'), true)
  assert.equal(looksLikeMetaDescription('this post is about seasonal car care.'), true)
})

test('a real, complete post does not trigger a false positive', () => {
  assert.equal(
    looksLikeMetaDescription(
      'Зимой дорожная соль и грязь особенно быстро разрушают лакокрасочное покрытие. Керамическое покрытие создаёт защитный слой, который отталкивает грязь и облегчает мойку — машину достаточно один раз обработать осенью, и всю зиму кузов выглядит чище. Запишитесь на диагностику покрытия в DriveSet.',
    ),
    false,
  )
  assert.equal(
    looksLikeMetaDescription(
      'Ceramic coating adds a protective layer that repels road salt and grime, so winter washes take half the time. Book a free consultation this week.',
    ),
    false,
  )
})

test('a post that merely mentions "post" mid-sentence is not flagged — only the opening framing is checked', () => {
  assert.equal(looksLikeMetaDescription('Этот пост набрал тысячу лайков благодаря честному отзыву клиента о нашей работе.'), false)
})
