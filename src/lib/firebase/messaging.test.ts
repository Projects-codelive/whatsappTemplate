import { describe, expect, it } from 'vitest'
import { buildFcmMessage } from './messaging'

describe('buildFcmMessage', () => {
  it('builds a standard message without image', () => {
    const msg = buildFcmMessage({
      token: 'abc123',
      title: 'Hello',
      body: 'World',
    }) as { message: { token: string; notification: Record<string, string>; data: Record<string, string>; android: Record<string, unknown> } }
    expect(msg.message.token).toBe('abc123')
    expect(msg.message.notification.title).toBe('Hello')
    expect(msg.message.notification.body).toBe('World')
    expect(msg.message.notification.image).toBeUndefined()
  })

  it('includes image when provided', () => {
    const msg = buildFcmMessage({
      token: 'abc123',
      title: 'Hello',
      body: 'World',
      image: 'https://example.com/img.png',
    }) as { message: { notification: Record<string, string> } }
    expect(msg.message.notification.image).toBe('https://example.com/img.png')
  })

  it('does not include image when absent', () => {
    const msg = buildFcmMessage({
      token: 'abc123',
      title: 'Hello',
      body: 'World',
    }) as { message: { notification: Record<string, string> } }
    expect('image' in msg.message.notification).toBe(false)
  })

  it('appends agent to body when provided', () => {
    const msg = buildFcmMessage({
      token: 'abc123',
      title: 'Hello',
      body: 'World',
      agent: 'Bot',
    }) as { message: { notification: Record<string, string> } }
    expect(msg.message.notification.body).toBe('World || Bot')
  })
})
