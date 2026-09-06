import { en } from './en'
import { ru } from './ru'
import type { Locale } from '../locale'

export type Messages = typeof en

export const messages: Record<Locale, Messages> = { en, ru }
