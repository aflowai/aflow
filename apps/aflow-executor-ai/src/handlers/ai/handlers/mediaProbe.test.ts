/**
 * The receipt records what the file states. A reader that guesses is worse than
 * one that says nothing, so every case here also pins the empty answer.
 */
import { describe, it, expect } from 'vitest';
import { probeRenderedFormat } from './mediaProbe.js';

function u16be(value: number): Buffer {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value);
  return bytes;
}

function u16le(value: number): Buffer {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
}

function u24le(value: number): Buffer {
  const bytes = Buffer.alloc(3);
  bytes.writeUIntLE(value, 0, 3);
  return bytes;
}

function u32be(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function u32le(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function box(type: string, body: Buffer): Buffer {
  return Buffer.concat([u32be(8 + body.length), Buffer.from(type, 'latin1'), body]);
}

function tkhdBody(width: number, height: number): Buffer {
  const body = Buffer.alloc(84);
  body.writeUInt32BE(width * 65_536, 76);
  body.writeUInt32BE(height * 65_536, 80);
  return body;
}

function mvhdBody(timescale: number, durationUnits: number): Buffer {
  const body = Buffer.alloc(100);
  body.writeUInt32BE(timescale, 12);
  body.writeUInt32BE(durationUnits, 16);
  return body;
}

describe('probeRenderedFormat — images', () => {
  it('reads a PNG header', () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      u32be(13),
      Buffer.from('IHDR', 'latin1'),
      u32be(1024),
      u32be(768),
    ]);
    expect(probeRenderedFormat('image', png)).toEqual({ width: 1024, height: 768 });
  });

  it('walks JPEG segments to the frame header', () => {
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xe0, 0x00, 0x10]),
      Buffer.alloc(14),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]),
      u16be(480),
      u16be(640),
      Buffer.alloc(8),
    ]);
    expect(probeRenderedFormat('image', jpeg)).toEqual({ width: 640, height: 480 });
  });

  it('reads a WebP extended-format canvas', () => {
    const webp = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      u32le(22),
      Buffer.from('WEBP', 'latin1'),
      Buffer.from('VP8X', 'latin1'),
      u32le(10),
      Buffer.alloc(4),
      u24le(1919),
      u24le(1079),
    ]);
    expect(probeRenderedFormat('image', webp)).toEqual({ width: 1920, height: 1080 });
  });

  it('reads a GIF logical screen descriptor', () => {
    const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), u16le(320), u16le(240)]);
    expect(probeRenderedFormat('image', gif)).toEqual({ width: 320, height: 240 });
  });

  it('says nothing about bytes it cannot read', () => {
    expect(probeRenderedFormat('image', Buffer.from('not an image at all'))).toEqual({});
    expect(probeRenderedFormat('image', Buffer.alloc(0))).toEqual({});
  });
});

describe('probeRenderedFormat — video', () => {
  it('reads the movie duration and the first sized track', () => {
    const mp4 = Buffer.concat([
      box('ftyp', Buffer.alloc(8)),
      box(
        'moov',
        Buffer.concat([
          box('mvhd', mvhdBody(600, 4800)),
          box('trak', box('tkhd', tkhdBody(0, 0))),
          box('trak', box('tkhd', tkhdBody(1920, 1080))),
        ]),
      ),
    ]);
    expect(probeRenderedFormat('video', mp4)).toEqual({
      width: 1920,
      height: 1080,
      durationSeconds: 8,
    });
  });

  it('reports the duration alone when no track states a size', () => {
    const mp4 = box('moov', box('mvhd', mvhdBody(1000, 12_500)));
    expect(probeRenderedFormat('video', mp4)).toEqual({ durationSeconds: 12.5 });
  });

  it('says nothing when the container carries no movie header', () => {
    expect(probeRenderedFormat('video', box('ftyp', Buffer.alloc(8)))).toEqual({});
    expect(probeRenderedFormat('video', Buffer.from('a truncated download'))).toEqual({});
  });
});
