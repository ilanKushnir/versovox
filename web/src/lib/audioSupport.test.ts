import { describe, expect, it } from 'vitest';
import { audioFormatSupport, bookAudioSupport } from './audioSupport';

/** Simulated canPlayType tables. */
const safari = (mime: string) => (/audio\/mp4|audio\/mpeg|audio\/flac/.test(mime) ? 'maybe' : '');
const chrome = (mime: string) => (mime.startsWith('audio/') ? 'probably' : '');

describe('audioFormatSupport', () => {
  it('marks Ogg/Opus unsupported on a Safari-like browser with an honest reason', () => {
    const ogg = audioFormatSupport('ogg', safari);
    expect(ogg.supported).toBe(false);
    expect(ogg.reason).toMatch(/OGG/);
    const opus = audioFormatSupport('opus', safari);
    expect(opus.supported).toBe(false);
  });

  it('accepts everything on a Chrome-like browser', () => {
    for (const f of ['m4b', 'm4a', 'mp3', 'flac', 'ogg', 'opus']) {
      expect(audioFormatSupport(f, chrome).supported).toBe(true);
    }
  });

  it('treats unknown formats as unknown rather than blocking playback', () => {
    expect(audioFormatSupport('multi', safari).level).toBe('unknown');
    expect(audioFormatSupport('multi', safari).supported).toBe(true);
  });
});

describe('bookAudioSupport', () => {
  it('a single unsupported track makes the book unsupported', () => {
    const s = bookAudioSupport(['mp3', 'opus'], safari);
    expect(s.supported).toBe(false);
    expect(s.reason).toMatch(/OPUS/);
  });

  it('all-supported tracks pass', () => {
    expect(bookAudioSupport(['mp3', 'm4b'], safari).supported).toBe(true);
  });
});
