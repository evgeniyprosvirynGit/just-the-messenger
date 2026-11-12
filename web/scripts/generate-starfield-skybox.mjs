import { mkdir, rm, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";

const outputDirectory = fileURLToPath(new URL("../public/skybox/", import.meta.url));
const textureSize = 1024;
const starCountPerFace = 220;
const cubeFaces = ["positive-x", "negative-x", "positive-y", "negative-y", "positive-z", "negative-z"];
const starColors = [
  [220, 232, 255],
  [178, 207, 255],
  [247, 242, 229],
  [255, 216, 176],
];

function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

function createPixelBuffer() {
  const pixels = Buffer.alloc(textureSize * textureSize * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = 3;
    pixels[offset + 1] = 7;
    pixels[offset + 2] = 18;
    pixels[offset + 3] = 255;
  }
  return pixels;
}

function addColor(pixels, offset, color, intensity) {
  for (let channel = 0; channel < 3; channel += 1) {
    pixels[offset + channel] = Math.min(255, pixels[offset + channel] + Math.round(color[channel] * intensity));
  }
}

function drawNebula(pixels, random) {
  const centerX = 260 + random() * 504;
  const centerY = 300 + random() * 424;
  const radiusX = 300 + random() * 250;
  const radiusY = 95 + random() * 90;
  const rotation = (-35 + random() * 70) * (Math.PI / 180);
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  const boundsX = Math.sqrt(radiusX ** 2 * cosine ** 2 + radiusY ** 2 * sine ** 2);
  const boundsY = Math.sqrt(radiusX ** 2 * sine ** 2 + radiusY ** 2 * cosine ** 2);
  const minX = Math.max(0, Math.floor(centerX - boundsX));
  const maxX = Math.min(textureSize - 1, Math.ceil(centerX + boundsX));
  const minY = Math.max(0, Math.floor(centerY - boundsY));
  const maxY = Math.min(textureSize - 1, Math.ceil(centerY + boundsY));
  const color = random() > 0.5 ? [50, 78, 126] : [76, 58, 112];
  const strength = 0.12 + random() * 0.04;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const deltaX = x - centerX;
      const deltaY = y - centerY;
      const localX = deltaX * cosine + deltaY * sine;
      const localY = -deltaX * sine + deltaY * cosine;
      const distance = localX ** 2 / radiusX ** 2 + localY ** 2 / radiusY ** 2;
      if (distance >= 1) continue;

      const intensity = strength * (1 - distance) ** 2;
      addColor(pixels, (y * textureSize + x) * 4, color, intensity);
    }
  }
}

function drawStar(pixels, random) {
  const magnitude = random();
  const radius = magnitude > 0.992
    ? 2.1 + random() * 0.6
    : magnitude > 0.94
      ? 1.1 + random() * 0.7
      : magnitude > 0.72
        ? 0.75 + random() * 0.35
        : 0.4 + random() * 0.35;
  const opacity = magnitude > 0.992
    ? 0.96
    : magnitude > 0.94
      ? 0.68 + random() * 0.22
      : magnitude > 0.72
        ? 0.45 + random() * 0.22
        : 0.28 + random() * 0.22;
  const color = starColors[Math.floor(random() * starColors.length)];
  const centerX = 12 + random() * (textureSize - 24);
  const centerY = 12 + random() * (textureSize - 24);
  const haloRadius = radius > 2 ? radius * 4 : radius * 2.5;
  const coreSigma = Math.max(0.45, radius * 0.65);
  const haloSigma = Math.max(1, radius * 2.1);

  for (let y = Math.max(0, Math.floor(centerY - haloRadius)); y <= Math.min(textureSize - 1, Math.ceil(centerY + haloRadius)); y += 1) {
    for (let x = Math.max(0, Math.floor(centerX - haloRadius)); x <= Math.min(textureSize - 1, Math.ceil(centerX + haloRadius)); x += 1) {
      const distanceSquared = (x - centerX) ** 2 + (y - centerY) ** 2;
      const core = Math.exp(-distanceSquared / (2 * coreSigma ** 2));
      const halo = radius > 2 ? 0.14 * Math.exp(-distanceSquared / (2 * haloSigma ** 2)) : 0;
      const intensity = Math.min(1, opacity * (core + halo));
      if (intensity > 0.005) addColor(pixels, (y * textureSize + x) * 4, color, intensity);
    }
  }
}

function createCrcTable() {
  return Uint32Array.from({ length: 256 }, (_, value) => {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    return crc >>> 0;
  });
}

const crcTable = createCrcTable();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function createPngChunk(type, data = Buffer.alloc(0)) {
  const chunkData = Buffer.concat([Buffer.from(type), data]);
  const chunk = Buffer.allocUnsafe(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunkData.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(chunkData), 4 + chunkData.length);
  return chunk;
}

function encodePng(pixels) {
  const bytesPerRow = textureSize * 4;
  const scanlines = Buffer.alloc(textureSize * (bytesPerRow + 1));
  for (let row = 0; row < textureSize; row += 1) {
    const destinationOffset = row * (bytesPerRow + 1);
    scanlines[destinationOffset] = 0;
    pixels.copy(scanlines, destinationOffset + 1, row * bytesPerRow, (row + 1) * bytesPerRow);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(textureSize, 0);
  header.writeUInt32BE(textureSize, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    createPngChunk("IHDR", header),
    createPngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    createPngChunk("IEND"),
  ]);
}

function createFace(faceIndex) {
  const random = createRandom(202_611_120 + faceIndex * 7919);
  const pixels = createPixelBuffer();
  drawNebula(pixels, random);
  drawNebula(pixels, random);
  for (let star = 0; star < starCountPerFace; star += 1) drawStar(pixels, random);
  return encodePng(pixels);
}

await mkdir(outputDirectory, { recursive: true });
await Promise.all(cubeFaces.map((face) => rm(path.join(outputDirectory, `${face}.svg`), { force: true })));
await Promise.all(cubeFaces.map((face, index) => writeFile(
  path.join(outputDirectory, `${face}.png`),
  createFace(index),
)));
console.log(`Generated ${cubeFaces.length} deterministic ${textureSize}px PNG starfield faces.`);
