import { describe, expect, it } from 'vitest'
import {
  ALLOWED_NOTIFICATION_IMAGE_TYPES,
  MAX_NOTIFICATION_IMAGE_BYTES,
  validateNotificationImage,
} from './notification-image'

function file(type: string, size: number, name = 'image.png'): File {
  return new File([new Uint8Array(size)], name, { type })
}

describe('validateNotificationImage', () => {
  it('accepts jpeg, png, and webp', () => {
    expect(ALLOWED_NOTIFICATION_IMAGE_TYPES.has('image/jpeg')).toBe(true)
    expect(ALLOWED_NOTIFICATION_IMAGE_TYPES.has('image/png')).toBe(true)
    expect(ALLOWED_NOTIFICATION_IMAGE_TYPES.has('image/webp')).toBe(true)
    expect(validateNotificationImage(file('image/jpeg', 100)).ok).toBe(true)
    expect(validateNotificationImage(file('image/png', 100)).ok).toBe(true)
    expect(validateNotificationImage(file('image/webp', 100)).ok).toBe(true)
  })

  it('rejects unsupported image types', () => {
    const result = validateNotificationImage(file('image/gif', 100))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('Unsupported image type')
  })

  it('rejects oversized images', () => {
    const result = validateNotificationImage(
      file('image/png', MAX_NOTIFICATION_IMAGE_BYTES + 1),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('too large')
  })

  it('accepts an image exactly at the size limit', () => {
    expect(
      validateNotificationImage(file('image/png', MAX_NOTIFICATION_IMAGE_BYTES)).ok,
    ).toBe(true)
  })
})
