// Standalone Canny edge detector operating on ImageData.
// Steps: grayscale -> Gaussian blur -> Sobel gradients -> non-max suppression -> hysteresis thresholding.

function toGrayscale(imageData) {
  const { data, width, height } = imageData;
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return gray;
}

function gaussianBlur(src, width, height) {
  // Fixed 5x5 kernel, sigma ~1.4
  const kernel = [2, 4, 5, 4, 2, 4, 9, 12, 9, 4, 5, 12, 15, 12, 5, 4, 9, 12, 9, 4, 2, 4, 5, 4, 2];
  const kernelSum = 159;
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let k = 0;
      for (let ky = -2; ky <= 2; ky++) {
        const sy = Math.min(height - 1, Math.max(0, y + ky));
        for (let kx = -2; kx <= 2; kx++) {
          const sx = Math.min(width - 1, Math.max(0, x + kx));
          sum += src[sy * width + sx] * kernel[k++];
        }
      }
      out[y * width + x] = sum / kernelSum;
    }
  }
  return out;
}

function sobel(src, width, height) {
  const gx = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
  const gy = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
  const magnitude = new Float32Array(width * height);
  const direction = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sx = 0;
      let sy = 0;
      let k = 0;
      for (let ky = -1; ky <= 1; ky++) {
        const py = Math.min(height - 1, Math.max(0, y + ky));
        for (let kx = -1; kx <= 1; kx++) {
          const px = Math.min(width - 1, Math.max(0, x + kx));
          const v = src[py * width + px];
          sx += v * gx[k];
          sy += v * gy[k];
          k++;
        }
      }
      const idx = y * width + x;
      magnitude[idx] = Math.hypot(sx, sy);
      direction[idx] = Math.atan2(sy, sx);
    }
  }
  return { magnitude, direction };
}

function nonMaxSuppression(magnitude, direction, width, height) {
  const out = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      let angle = (direction[idx] * 180) / Math.PI;
      if (angle < 0) angle += 180;

      let n1, n2;
      if ((angle >= 0 && angle < 22.5) || angle >= 157.5) {
        n1 = magnitude[idx - 1];
        n2 = magnitude[idx + 1];
      } else if (angle < 67.5) {
        n1 = magnitude[idx - width + 1];
        n2 = magnitude[idx + width - 1];
      } else if (angle < 112.5) {
        n1 = magnitude[idx - width];
        n2 = magnitude[idx + width];
      } else {
        n1 = magnitude[idx - width - 1];
        n2 = magnitude[idx + width + 1];
      }

      out[idx] = magnitude[idx] >= n1 && magnitude[idx] >= n2 ? magnitude[idx] : 0;
    }
  }
  return out;
}

function hysteresis(suppressed, width, height, lowThreshold, highThreshold) {
  const STRONG = 255;
  const WEAK = 75;
  const result = new Uint8ClampedArray(width * height);
  const stack = [];

  for (let i = 0; i < suppressed.length; i++) {
    if (suppressed[i] >= highThreshold) {
      result[i] = STRONG;
      stack.push(i);
    } else if (suppressed[i] >= lowThreshold) {
      result[i] = WEAK;
    }
  }

  while (stack.length) {
    const idx = stack.pop();
    const x = idx % width;
    const y = Math.floor(idx / width);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const nIdx = ny * width + nx;
        if (result[nIdx] === WEAK) {
          result[nIdx] = STRONG;
          stack.push(nIdx);
        }
      }
    }
  }

  for (let i = 0; i < result.length; i++) {
    if (result[i] !== STRONG) result[i] = 0;
  }

  return result;
}

// Non-max suppression naturally thins edges down to a single pixel wide.
// A separable box dilation (horizontal pass then vertical pass, each O(n·r)
// rather than a naive O(n·r²) 2D scan) thickens that back up: a 1px line
// dilated by `radius` becomes (2*radius + 1) pixels wide.
function dilate(binary, width, height, radius) {
  if (radius <= 0) return binary;

  const temp = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    for (let x = 0; x < width; x++) {
      const xs = Math.max(0, x - radius);
      const xe = Math.min(width - 1, x + radius);
      let v = 0;
      for (let xx = xs; xx <= xe; xx++) {
        if (binary[rowOff + xx] > 0) {
          v = 255;
          break;
        }
      }
      temp[rowOff + x] = v;
    }
  }

  const out = new Uint8ClampedArray(width * height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const ys = Math.max(0, y - radius);
      const ye = Math.min(height - 1, y + radius);
      let v = 0;
      for (let yy = ys; yy <= ye; yy++) {
        if (temp[yy * width + x] > 0) {
          v = 255;
          break;
        }
      }
      out[y * width + x] = v;
    }
  }

  return out;
}

/**
 * Run Canny edge detection on an ImageData and return a new ImageData
 * (white edges on a black background, opaque). `edgeThickness` is the
 * dilation radius applied to the (naturally 1px-wide) detected edges —
 * radius 1 (the default) yields 3px-wide lines.
 */
export function cannyEdgeDetection(imageData, { lowThreshold = 30, highThreshold = 90, edgeThickness = 1 } = {}) {
  const { width, height } = imageData;
  const gray = toGrayscale(imageData);
  const blurred = gaussianBlur(gray, width, height);
  const { magnitude, direction } = sobel(blurred, width, height);
  const suppressed = nonMaxSuppression(magnitude, direction, width, height);
  const thin = hysteresis(suppressed, width, height, lowThreshold, highThreshold);
  const edges = dilate(thin, width, height, edgeThickness);

  const out = new ImageData(width, height);
  for (let i = 0, p = 0; i < out.data.length; i += 4, p++) {
    const v = edges[p];
    out.data[i] = v;
    out.data[i + 1] = v;
    out.data[i + 2] = v;
    out.data[i + 3] = 255;
  }
  return out;
}
