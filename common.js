"use strict";

/* ---------- opencv.js bootstrap ---------- */
let cvReady = false;
const loadingOverlay = document.getElementById("loadingOverlay");
loadingOverlay.classList.remove("hidden");

function onOpenCvReady() {
  cv["onRuntimeInitialized"] = () => {
    cvReady = true;
    loadingOverlay.classList.add("hidden");
    // Only the pages that need it define these (analyze.js / video.js).
    if (typeof updateDetectButtonState === "function") updateDetectButtonState();
    if (typeof updateProcessButtonState === "function") updateProcessButtonState();
  };
}
window.onOpenCvReady = onOpenCvReady;

/* ---------- drawing helpers ---------- */
function drawLineOn(ctx, canvas, p1, p2) {
  ctx.strokeStyle = "#4f9dff";
  ctx.lineWidth = Math.max(2, canvas.width / 500);
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.stroke();
}

function unitToMicrons(value, unit) {
  switch (unit) {
    case "nm": return value / 1000;
    case "mm": return value * 1000;
    default: return value; // um
  }
}

/* ---------- circle detection ---------- */
// Runs the Hough circle detector on any canvas (a still image, or a
// video canvas holding one sampled frame) given detection params in
// real-world units. Returns circles as [{x, y, r}] in that canvas's own
// pixel coordinates.
function detectCirclesOnCanvas(canvas, opts) {
  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  normalizeGrayInPlace(gray);
  cv.GaussianBlur(gray, gray, new cv.Size(9, 9), 2, 2);

  const detected = new cv.Mat();
  const minR = opts.minDiameterUm / opts.micronsPerPixel / 2;
  const maxR = opts.maxDiameterUm / opts.micronsPerPixel / 2;
  const minDistPx = opts.minDistUm / opts.micronsPerPixel;
  cv.HoughCircles(
    gray,
    detected,
    cv.HOUGH_GRADIENT,
    1,             // dp
    minDistPx,     // minDist between centers
    opts.param1,   // Canny high threshold
    opts.param2,   // accumulator threshold
    Math.min(minR, maxR), // minRadius
    Math.max(minR, maxR)  // maxRadius
  );

  const result = [];
  for (let i = 0; i < detected.cols; i++) {
    result.push({
      x: detected.data32F[i * 3],
      y: detected.data32F[i * 3 + 1],
      r: detected.data32F[i * 3 + 2],
    });
  }

  src.delete();
  gray.delete();
  detected.delete();
  return suppressDuplicateCircles(result);
}

// HoughCircles' own minDist parameter is set by the user to allow
// legitimately close/touching droplets, which also reopens the door for
// it to report two slightly different circles fit to the same blurry
// droplet edge as if they were separate droplets. This is a distinct
// problem from minDist and needs its own pass: near-perfectly-coincident
// centers (tight relative to droplet size) are almost certainly the same
// physical droplet fit twice — genuinely distinct droplets, even touching
// ones, still have centers separated by roughly their combined radii, not
// a few pixels of Hough fit jitter. Keeps circles in Hough's own return
// order (roughly strongest accumulator vote first) and drops later
// near-duplicates of an already-kept circle.
function suppressDuplicateCircles(circles) {
  const kept = [];
  const suppressed = new Array(circles.length).fill(false);
  for (let i = 0; i < circles.length; i++) {
    if (suppressed[i]) continue;
    const c = circles[i];
    kept.push(c);
    for (let j = i + 1; j < circles.length; j++) {
      if (suppressed[j]) continue;
      const other = circles[j];
      const dist = Math.hypot(c.x - other.x, c.y - other.y);
      if (dist < Math.min(c.r, other.r) * 0.6) suppressed[j] = true;
    }
  }
  return kept;
}

// Stretches a grayscale Mat's pixel values to fill the full 0-255 range
// in place. Detection otherwise struggles when brightness/contrast varies
// between images or frames (e.g. alternating illumination sources) — a
// fixed accumulator threshold on a dim frame just sees weaker edges than
// the same threshold on a bright one. Plain min/max normalization (not
// CLAHE) is used deliberately: it needs nothing beyond core Mat access,
// so it doesn't depend on which optional OpenCV.js modules happen to be
// compiled into a given build.
function normalizeGrayInPlace(gray) {
  const data = gray.data;
  let min = 255;
  let max = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  if (range < 1) return; // already flat; nothing to stretch
  const scale = 255 / range;
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.round((data[i] - min) * scale);
  }
}

/* ---------- contact angle geometry ---------- */
// Overlapping-pair contact angle, accounting for focal-plane (height)
// offset between droplets of different size. Model: each droplet is an
// undeformed sphere resting tangent to a shared horizontal substrate, so
// its center height above the substrate equals its own radius. Two
// droplets of different radii therefore have centers at different
// heights purely because of the size difference — combined with the
// apparent (image-plane) center-to-center distance, this gives the true
// 3D center distance, and from it the sphere-sphere intersection angle.
// Reported as 0deg for a bare graze and increasing as the droplets
// overlap/adhere more (the conventional droplet-adhesion direction) —
// the supplement of the raw angle between the two center-to-contact-point
// lines. See the Theory page for the full derivation and its limitations.
function computeContactPairsFor(circlesArr, mpp) {
  const pairs = [];
  for (let i = 0; i < circlesArr.length; i++) {
    for (let j = i + 1; j < circlesArr.length; j++) {
      const a = circlesArr[i];
      const b = circlesArr[j];
      const distPx = Math.hypot(b.x - a.x, b.y - a.y);
      if (distPx >= a.r + b.r) continue; // apparent circles don't overlap

      const r1 = a.r * mpp;
      const r2 = b.r * mpp;
      const dxy = distPx * mpp; // apparent lateral separation
      const dz = Math.abs(r1 - r2); // inferred height difference
      const D = Math.hypot(dxy, dz); // true 3D center-to-center distance

      const inContact3D = D <= r1 + r2;
      let angleDeg = null;
      if (inContact3D) {
        const cosT = (D * D - r1 * r1 - r2 * r2) / (2 * r1 * r2);
        angleDeg = (Math.acos(Math.min(1, Math.max(-1, cosT))) * 180) / Math.PI;
      }
      pairs.push({ i, j, r1, r2, dxy, D, angleDeg, inContact3D });
    }
  }
  return pairs;
}

function drawContactPairsOn(ctx, canvas, circlesArr, pairs) {
  if (!pairs.length) return;
  const fontSize = Math.max(11, canvas.width / 85);
  ctx.font = `${fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = Math.max(1.5, canvas.width / 700);

  pairs.forEach((pair) => {
    const a = circlesArr[pair.i];
    const b = circlesArr[pair.j];
    ctx.strokeStyle = pair.inContact3D ? "#4fd18b" : "#9aa3b2";
    ctx.setLineDash(pair.inContact3D ? [] : [5, 4]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);

    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const label = pair.inContact3D ? `${pair.angleDeg.toFixed(1)}°` : "n/c";
    ctx.lineWidth = Math.max(2, fontSize / 5);
    ctx.strokeStyle = "black";
    ctx.strokeText(label, midX, midY);
    ctx.fillStyle = pair.inContact3D ? "#4fd18b" : "#9aa3b2";
    ctx.fillText(label, midX, midY);
    ctx.lineWidth = Math.max(1.5, canvas.width / 700);
  });
}

function drawCirclesOn(ctx, canvas, circlesArr) {
  const fontSize = Math.max(12, canvas.width / 70);
  ctx.lineWidth = Math.max(2, canvas.width / 500);
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  circlesArr.forEach((c, i) => {
    ctx.strokeStyle = "#ff5c5c";
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.r, 0, 2 * Math.PI);
    ctx.stroke();

    // Index label matches the results table row, so a droplet can be
    // found in the image from its row (or vice versa).
    const label = String(i + 1);
    ctx.lineWidth = Math.max(2, fontSize / 5);
    ctx.strokeStyle = "black";
    ctx.strokeText(label, c.x, c.y);
    ctx.fillStyle = "#ff5c5c";
    ctx.fillText(label, c.x, c.y);
    ctx.lineWidth = Math.max(2, canvas.width / 500);
  });
}

/* ---------- data export ---------- */
function downloadCsv(filename, rows) {
  const blob = new Blob([rows.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// aoa: array-of-arrays, first row is the header. Numeric cells should be
// real numbers (not strings) so Excel treats them as numbers.
function downloadXlsx(filename, sheetName, aoa) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, filename);
}
