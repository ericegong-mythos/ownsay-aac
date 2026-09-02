import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let i = 0; i < 8; i += 1) {
      const mask = -(crc & 1)
      crc = (crc >>> 1) ^ (0xedb88320 & mask)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crcSource = Buffer.concat([typeBytes, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(crcSource))
  return Buffer.concat([length, typeBytes, data, crc])
}

function png(width, height, paint) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1)
    raw[row] = 0
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = paint(x, y, width, height)
      const offset = row + 1 + x * 4
      raw[offset] = r
      raw[offset + 1] = g
      raw[offset + 2] = b
      raw[offset + 3] = a
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function color(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 255]
}

function roundedRect(px, py, x, y, w, h, r, fill) {
  if (px < x || py < y || px >= x + w || py >= y + h) return false
  const lx = px - x
  const ly = py - y
  const inCorner =
    (lx < r && ly < r && (lx - r) ** 2 + (ly - r) ** 2 > r * r) ||
    (lx > w - r && ly < r && (lx - (w - r)) ** 2 + (ly - r) ** 2 > r * r) ||
    (lx < r && ly > h - r && (lx - r) ** 2 + (ly - (h - r)) ** 2 > r * r) ||
    (lx > w - r && ly > h - r && (lx - (w - r)) ** 2 + (ly - (h - r)) ** 2 > r * r)
  return inCorner ? false : fill
}

function triangle(px, py, ax, ay, bx, by, cx, cy) {
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
  const s = ((ay - cy) * (px - cx) + (cx - ax) * (py - cy)) / area
  const t = ((cy - by) * (px - cx) + (bx - cx) * (py - cy)) / area
  return s >= 0 && t >= 0 && s + t <= 1
}

function paint(x, y, size) {
  const navy = color('#102542')
  const paper = color('#F7F5F0')
  const sky = color('#4F8FD8')
  const teal = color('#54B7B0')
  const coral = color('#EF816B')
  const violet = color('#9A84C8')
  if (!roundedRect(x, y, 0, 0, size, size, size * 0.18, true)) return [0, 0, 0, 0]

  // Resolve top-most shapes first: the foreground message and its three
  // authored tokens sit above the offset teal response bubble.
  if (roundedRect(x, y, size * 0.20, size * 0.34, size * 0.14, size * 0.14, size * 0.04, true)) return sky
  if (roundedRect(x, y, size * 0.38, size * 0.34, size * 0.14, size * 0.14, size * 0.04, true)) return coral
  if (roundedRect(x, y, size * 0.56, size * 0.34, size * 0.17, size * 0.14, size * 0.04, true)) return violet
  if (triangle(x, y, size * 0.48, size * 0.61, size * 0.72, size * 0.82, size * 0.62, size * 0.56)) return paper
  if (roundedRect(x, y, size * 0.08, size * 0.17, size * 0.76, size * 0.50, size * 0.12, true)) return paper
  if (triangle(x, y, size * 0.58, size * 0.66, size * 0.78, size * 0.86, size * 0.68, size * 0.62)) return teal
  if (roundedRect(x, y, size * 0.14, size * 0.24, size * 0.76, size * 0.50, size * 0.12, true)) return teal
  return navy
}

for (const size of [192, 512]) {
  writeFileSync(join(root, 'public/icons', `icon-${size}.png`), png(size, size, (x, y) => paint(x, y, size)))
}
