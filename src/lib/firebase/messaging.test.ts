import { describe, expect, it } from 'vitest'
import { buildFcmMessage } from './messaging'

function notificationOf(
  args: Parameters<typeof buildFcmMessage>[0],
): Record<string, string> {
  const message = buildFcmMessage(args).message as { notification: Record<string, string> }
  return message.notification
}

describe('buildFcmMessage', () => {
  it('builds the base payload without an image key', () => {
    const notification = notificationOf({ token: 'tok', title: 'Hi', body: 'Body' })
    expect(notification).toEqual({ title: 'Hi', body: 'Body' })
    expect('image' in notification).toBe(false)
  })

  it('includes the image when provided', () => {
    const notification = notificationOf({
      token: 'tok',
      title: 'Hi',
      body: 'Body',
      image: 'https://example.com/img.png',
    })
    expect(notification.image).toBe('https://example.com/img.png')
  })

  it('omits the image for empty-string images', () => {
    const notification = notificationOf({
      token: 'tok',
      title: 'Hi',
      body: 'Body',
      image: '',
    })
    expect('image' in notification).toBe(false)
  })

  it('keeps the agent body suffix behaviour', () => {
    const notification = notificationOf({
      token: 'tok',
      title: 'Hi',
      body: 'Body',
      agent: 'Agent',
      image: 'https://example.com/img.png',
    })
    expect(notification.body).toBe('Body || Agent')
    expect(notification.image).toBe('https://example.com/img.png')
  })
})
