import { describe, expect, it } from 'vitest'
import { validateSendRequest, isHttpUrl } from './validate-send-request'

describe('isHttpUrl', () => {
  it('accepts http and https URLs', () => {
    expect(isHttpUrl('https://example.com/image.png')).toBe(true)
    expect(isHttpUrl('http://example.com/a')).toBe(true)
  })

  it('rejects non-http(s) values', () => {
    expect(isHttpUrl('')).toBe(false)
    expect(isHttpUrl('ftp://example.com/a')).toBe(false)
    expect(isHttpUrl('not a url')).toBe(false)
    expect(isHttpUrl('data:image/png;base64,xx')).toBe(false)
  })
})

describe('validateSendRequest', () => {
  it('accepts a minimal selected payload', () => {
    const result = validateSendRequest({
      target: 'selected',
      userIds: ['a'],
      title: 'Hi',
      message: 'Body',
    })
    expect(result.ok).toBe(true)
  })

  it('accepts an optional image URL', () => {
    const result = validateSendRequest({
      target: 'selected',
      userIds: ['a'],
      title: 'Hi',
      message: 'Body',
      imageUrl: 'https://cdn.example.com/img.png',
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.payload.imageUrl).toBe('https://cdn.example.com/img.png')
  })

  it('rejects an invalid image URL', () => {
    const result = validateSendRequest({
      target: 'selected',
      userIds: ['a'],
      title: 'Hi',
      message: 'Body',
      imageUrl: 'not-a-url',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('image must be a valid')
  })

  it('drops a blank imageUrl', () => {
    const result = validateSendRequest({
      target: 'selected',
      userIds: ['a'],
      title: 'Hi',
      message: 'Body',
      imageUrl: '   ',
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.payload.imageUrl).toBeUndefined()
  })

  it('requires a title', () => {
    const result = validateSendRequest({
      target: 'selected',
      userIds: ['a'],
      title: '  ',
      message: 'Body',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('Notification title is required')
  })

  it('requires a message', () => {
    const result = validateSendRequest({
      target: 'selected',
      userIds: ['a'],
      title: 'Hi',
      message: '',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('Notification message is required')
  })

  it('requires at least one selected user', () => {
    const result = validateSendRequest({
      target: 'selected',
      userIds: [],
      title: 'Hi',
      message: 'Body',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('Select at least one user')
  })

  it('accepts an all payload', () => {
    const result = validateSendRequest({
      target: 'all',
      title: 'Hi',
      message: 'Body',
    })
    expect(result.ok).toBe(true)
  })

  it('rejects an unknown category', () => {
    const result = validateSendRequest({
      target: 'category',
      category: 'Platinum',
      title: 'Hi',
      message: 'Body',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('Invalid notification category')
  })

  it('rejects an unknown target', () => {
    const result = validateSendRequest({
      target: 'pigeon',
      title: 'Hi',
      message: 'Body',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('Invalid notification target')
  })
})
