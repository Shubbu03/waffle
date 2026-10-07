import { beforeEach, expect, mock, test } from 'bun:test'
import { createRequire } from 'node:module'
import { createElement, type ReactNode } from 'react'
import { summaryFixture } from '../test-support/signal-fixture'

// Exercise the real Slot merge used by Expo Link, without starting a native UI.
const routerRequire = createRequire(require.resolve('expo-router/package.json'))
const { Slot } = routerRequire('@radix-ui/react-slot')
const { renderToStaticMarkup }: { renderToStaticMarkup: (element: ReactNode) => string } = require('react-dom/server')
type Layout = { flexDirection?: string; paddingVertical?: number; minHeight?: number; gap?: number }
const receivedStyles: Layout[] = []
mock.module('expo-router', () => ({
  Link: ({ children }: { children: ReactNode }) => createElement(Slot, { style: undefined }, children),
}))
mock.module('react-native', () => ({
  Pressable: ({
    children,
    style,
  }: {
    children: ReactNode
    style: Layout | ((state: { pressed: boolean }) => Layout)
  }) => {
    receivedStyles.push(typeof style === 'function' ? style({ pressed: false }) : style)
    return createElement('div', null, children)
  },
  View: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}))
mock.module('@/components/app-text', () => ({
  AppText: ({ children }: { children: ReactNode }) => createElement('span', null, children),
}))
mock.module('@/components/ui/ui-icon-symbol', () => ({ UiIconSymbol: () => null }))
mock.module('@/hooks/use-theme-color', () => ({ useThemeColor: () => '#171A16' }))

const { HomeActivityRow, HomeWatchlistRow } = await import('../components/home/home-overview-rows')
beforeEach(() => {
  receivedStyles.length = 0
})

test('Home wallet navigation preserves horizontal layout and spacing through the Link Slot', () => {
  renderToStaticMarkup(
    createElement(HomeWatchlistRow, {
      wallet: {
        id: 'wallet',
        label: 'Tracked wallet',
        address: 'wallet-address',
        active: true,
        latestActivityAt: null,
      },
      now: 0,
      last: false,
    }),
  )
  expect(receivedStyles).toHaveLength(1)
  expect(receivedStyles[0]?.flexDirection).toBe('row')
  expect(receivedStyles[0]?.paddingVertical).toBeGreaterThan(0)
  expect(receivedStyles[0]?.gap).toBeGreaterThan(0)
})

test('Home transaction navigation keeps the score beside the text through the Link Slot', () => {
  renderToStaticMarkup(
    createElement(HomeActivityRow, {
      signal: summaryFixture('1'),
      walletName: 'Tracked wallet',
      offline: false,
      now: 0,
      last: true,
    }),
  )
  expect(receivedStyles).toHaveLength(1)
  expect(receivedStyles[0]?.flexDirection).toBe('row')
  expect(receivedStyles[0]?.paddingVertical).toBeGreaterThan(0)
  expect(receivedStyles[0]?.minHeight).toBeGreaterThanOrEqual(44)
})
