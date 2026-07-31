"use strict";

/* ---------- state ---------- */
let cvReady = false;
let imgLoaded = false;
let calibrated = false;
let calibMode = "draw"; // "draw" | "direct"
let mode = "idle"; // "idle" | "calibrating"
let calibLine = null; // {x1,y1,x2,y2} in natural image pixel coords
let micronsPerPixel = null;
let circles = []; // [{x, y, r}] in natural image pixel coords
let contactPairs = []; // [{i, j, r1, r2, dxy, D, angleDeg, inContact3D}], r/dxy/D in microns

/* ---------- elements ---------- */
const dropZone = document.getElementById("dropZone");
const fileInput = document.getElementById("fileInput");
const stageWrap = document.getElementById("stageWrap");
const stageHint = document.getElementById("stageHint");
const imgCanvas = document.getElementById("imgCanvas");
const overlayCanvas = document.getElementById("overlayCanvas");
const ctxImg = imgCanvas.getContext("2d");
const ctxOverlay = overlayCanvas.getContext("2d");

const calibModeRadios = document.querySelectorAll('input[name="calibMode"]');
const calibDrawMode = document.getElementById("calibDrawMode");
const calibDirectMode = document.getElementById("calibDirectMode");
const btnDrawScale = document.getElementById("btnDrawScale");
const calibrateForm = document.getElementById("calibrateForm");
const knownLength = document.getElementById("knownLength");
const knownUnit = document.getElementById("knownUnit");
const btnConfirmScale = document.getElementById("btnConfirmScale");
const directScaleValue = document.getElementById("directScaleValue");
const btnConfirmDirectScale = document.getElementById("btnConfirmDirectScale");
const scaleResult = document.getElementById("scaleResult");

const minDiameterUm = document.getElementById("minDiameterUm");
const maxDiameterUm = document.getElementById("maxDiameterUm");
const minDistUm = document.getElementById("minDistUm");
const param1 = document.getElementById("param1");
const param2 = document.getElementById("param2");
const btnDetect = document.getElementById("btnDetect");

const statsBox = document.getElementById("statsBox");
const histCanvas = document.getElementById("histCanvas");
const tableWrap = document.getElementById("tableWrap");
const resultsTableBody = document.querySelector("#resultsTable tbody");
const btnExport = document.getElementById("btnExport");

const contactSection = document.getElementById("contactSection");
const contactTableWrap = document.getElementById("contactTableWrap");
const contactTableBody = document.querySelector("#contactTable tbody");
const btnExportContacts = document.getElementById("btnExportContacts");

const loadingOverlay = document.getElementById("loadingOverlay");

/* ---------- tabs ---------- */
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.classList.toggle("active", b === btn);
      b.setAttribute("aria-selected", b === btn ? "true" : "false");
    });
    document.querySelectorAll(".tab-panel").forEach((panel) => {
      panel.classList.toggle("hidden", panel.id !== `tab${capitalize(btn.dataset.tab)}`);
    });
  });
});
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ---------- opencv.js bootstrap ---------- */
loadingOverlay.classList.remove("hidden");

function onOpenCvReady() {
  cv["onRuntimeInitialized"] = () => {
    cvReady = true;
    loadingOverlay.classList.add("hidden");
    updateDetectButtonState();
    updateProcessButtonState();
  };
}
window.onOpenCvReady = onOpenCvReady;

/* ---------- slider label wiring ---------- */
[
  [param1, "param1Val", (v) => v],
  [param2, "param2Val", (v) => v],
].forEach(([input, labelId, transform]) => {
  const label = document.getElementById(labelId);
  const update = () => (label.textContent = transform(Number(input.value)));
  input.addEventListener("input", update);
  update();
});

/* ---------- image loading ---------- */
dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("dragover");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  if (e.dataTransfer.files.length) loadImageFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", () => {
  if (fileInput.files.length) loadImageFile(fileInput.files[0]);
});

function loadImageFile(file) {
  const isTiff = /\.tiff?$/i.test(file.name) || file.type === "image/tiff";
  if (isTiff) {
    loadTiffFile(file);
    return;
  }
  if (!file.type.startsWith("image/")) return;

  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    finalizeNewImage(img.naturalWidth, img.naturalHeight, () => ctxImg.drawImage(img, 0, 0));
    URL.revokeObjectURL(url);
  };
  img.onerror = () => {
    stageHint.textContent = "Could not load that image file.";
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

// Browsers can't decode TIFF natively (no <img>/canvas support), so TIFF
// files are decoded in JS via UTIF.js and blitted to the canvas as RGBA.
// Only the first frame of multi-page TIFFs is used.
function loadTiffFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const buffer = reader.result;
      const ifds = UTIF.decode(buffer);
      if (!ifds.length) throw new Error("no image frames found");
      const ifd = ifds[0];
      UTIF.decodeImage(buffer, ifd, ifds);
      const rgba = UTIF.toRGBA8(ifd);
      const { width, height } = ifd;
      finalizeNewImage(width, height, () => {
        ctxImg.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
      });
    } catch (err) {
      console.error(err);
      stageHint.textContent =
        "Could not decode that TIFF file. If this keeps happening, try converting it to PNG first (e.g. in ImageJ/Fiji: File → Save As → PNG).";
    }
  };
  reader.onerror = () => {
    stageHint.textContent = "Could not read that file.";
  };
  reader.readAsArrayBuffer(file);
}

function finalizeNewImage(width, height, drawFn) {
  imgCanvas.width = width;
  imgCanvas.height = height;
  overlayCanvas.width = width;
  overlayCanvas.height = height;
  drawFn();
  ctxOverlay.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  stageWrap.classList.remove("hidden");
  dropZone.classList.add("hidden");
  stageHint.textContent = `${width} × ${height} px`;

  imgLoaded = true;
  circles = [];
  contactPairs = [];
  calibLine = null;
  calibrateForm.classList.add("hidden");
  resetResults();

  // A drawn scale line is tied to this image's pixel coordinates and
  // can't carry over; a directly-entered µm/px value has no such tie,
  // so it's left applied across new images.
  if (calibMode === "draw") {
    calibrated = false;
    micronsPerPixel = null;
    scaleResult.classList.add("hidden");
  } else if (calibrated) {
    scaleResult.textContent = `Scale set: 1 px = ${micronsPerPixel.toFixed(4)} µm`;
    scaleResult.classList.remove("hidden");
  }

  btnDrawScale.disabled = false;
  updateDetectButtonState();
}

/* ---------- coordinate helpers ---------- */
// Convert a mouse/pointer event to natural image pixel coordinates,
// accounting for the canvas being scaled down by CSS (max-width:100%).
function eventToCanvasPoint(evt) {
  const rect = overlayCanvas.getBoundingClientRect();
  const scaleX = overlayCanvas.width / rect.width;
  const scaleY = overlayCanvas.height / rect.height;
  return {
    x: (evt.clientX - rect.left) * scaleX,
    y: (evt.clientY - rect.top) * scaleY,
  };
}

/* ---------- calibration ---------- */
btnDrawScale.addEventListener("click", () => {
  mode = "calibrating";
  calibLine = null;
  calibrateForm.classList.add("hidden");
  scaleResult.classList.add("hidden");
  ctxOverlay.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  redrawCircles();
  stageHint.textContent = "Click and drag along a reference length, then release.";
});

let dragging = false;
let dragStart = null;

overlayCanvas.addEventListener("mousedown", (e) => {
  if (mode !== "calibrating") return;
  dragging = true;
  dragStart = eventToCanvasPoint(e);
});

overlayCanvas.addEventListener("mousemove", (e) => {
  if (mode !== "calibrating" || !dragging) return;
  const p = eventToCanvasPoint(e);
  ctxOverlay.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  redrawCircles();
  drawLine(dragStart, p);
});

overlayCanvas.addEventListener("mouseup", (e) => {
  if (mode !== "calibrating" || !dragging) return;
  dragging = false;
  const p = eventToCanvasPoint(e);
  calibLine = { x1: dragStart.x, y1: dragStart.y, x2: p.x, y2: p.y };
  ctxOverlay.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  redrawCircles();
  drawLine(dragStart, p);
  mode = "idle";
  const pxLen = Math.hypot(calibLine.x2 - calibLine.x1, calibLine.y2 - calibLine.y1);
  if (pxLen < 2) {
    stageHint.textContent = "Line too short — try drawing the scale line again.";
    calibLine = null;
    return;
  }
  calibrateForm.classList.remove("hidden");
  stageHint.textContent = `Line drawn: ${pxLen.toFixed(1)} px. Enter its real-world length.`;
});

function drawLine(p1, p2) {
  drawLineOn(ctxOverlay, overlayCanvas, p1, p2);
}

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

// Applies a newly-determined microns-per-pixel value, however it was
// obtained (drawn scale bar or directly entered), and refreshes anything
// downstream that depends on it.
function applyCalibration(newMicronsPerPixel, hintText) {
  micronsPerPixel = newMicronsPerPixel;
  calibrated = true;
  scaleResult.textContent = `Scale set: 1 px = ${micronsPerPixel.toFixed(4)} µm`;
  scaleResult.classList.remove("hidden");
  calibrateForm.classList.add("hidden");
  stageHint.textContent = hintText;
  updateDetectButtonState();
  if (circles.length) {
    // Re-calibrating changes microns-per-pixel, which the contact-angle
    // model depends on, so pairs and their overlay labels need refreshing too.
    contactPairs = computeContactPairs();
    ctxOverlay.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    redrawCircles();
    drawContactPairs();
    renderResults();
  }
}

btnConfirmScale.addEventListener("click", () => {
  if (!calibLine) return;
  const val = Number(knownLength.value);
  if (!val || val <= 0) {
    knownLength.focus();
    return;
  }
  const pxLen = Math.hypot(calibLine.x2 - calibLine.x1, calibLine.y2 - calibLine.y1);
  const realUm = unitToMicrons(val, knownUnit.value);
  applyCalibration(realUm / pxLen, "Scale calibrated. You can redraw it any time.");
});

btnConfirmDirectScale.addEventListener("click", () => {
  const val = Number(directScaleValue.value);
  if (!val || val <= 0) {
    directScaleValue.focus();
    return;
  }
  applyCalibration(val, "Scale set directly. It stays applied for images you upload afterward.");
});

calibModeRadios.forEach((radio) => {
  radio.addEventListener("change", () => {
    if (!radio.checked) return;
    calibMode = radio.value;
    calibDrawMode.classList.toggle("hidden", calibMode !== "draw");
    calibDirectMode.classList.toggle("hidden", calibMode !== "direct");
  });
});

/* ---------- detection ---------- */
function updateDetectButtonState() {
  btnDetect.disabled = !(cvReady && imgLoaded && calibrated);
  btnDetect.title = !cvReady
    ? "Waiting for OpenCV.js to load…"
    : !imgLoaded
    ? "Upload an image first"
    : !calibrated
    ? "Calibrate the scale first"
    : "";
}

btnDetect.addEventListener("click", runDetection);

function runDetection() {
  if (btnDetect.disabled) return;
  mode = "idle";

  circles = detectCirclesOnCanvas(imgCanvas, {
    minDiameterUm: Number(minDiameterUm.value),
    maxDiameterUm: Number(maxDiameterUm.value),
    minDistUm: Number(minDistUm.value),
    param1: Number(param1.value),
    param2: Number(param2.value),
    micronsPerPixel,
  });

  contactPairs = computeContactPairs();

  ctxOverlay.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  redrawCircles();
  drawContactPairs();
  renderResults();
}

// Runs the Hough circle detector on any canvas (the Analyze tab's image
// canvas, or a video-tab canvas holding one sampled frame) given detection
// params in real-world units. Returns circles as [{x, y, r}] in that
// canvas's own pixel coordinates.
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
// lines. See README for the full derivation and its limitations.
function computeContactPairs() {
  return computeContactPairsFor(circles, micronsPerPixel);
}

// Parameterized so it can run against either the Analyze tab's live
// `circles`/`micronsPerPixel`, or a single video frame's own detected
// circles and scale.
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

function drawContactPairs() {
  drawContactPairsOn(ctxOverlay, overlayCanvas, circles, contactPairs);
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

function redrawCircles() {
  drawCirclesOn(ctxOverlay, overlayCanvas, circles);
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

/* ---------- results: stats, table, histogram, csv ---------- */
function resetResults() {
  statsBox.classList.add("hidden");
  histCanvas.classList.add("hidden");
  tableWrap.classList.add("hidden");
  btnExport.classList.add("hidden");
  statsBox.innerHTML = "";
  resultsTableBody.innerHTML = "";

  contactSection.classList.add("hidden");
  contactTableWrap.classList.add("hidden");
  btnExportContacts.classList.add("hidden");
  contactTableBody.innerHTML = "";
}

function renderResults() {
  if (!circles.length) {
    resetResults();
    return;
  }

  const diametersPx = circles.map((c) => c.r * 2);
  const diametersUm = micronsPerPixel ? diametersPx.map((d) => d * micronsPerPixel) : null;

  const stats = computeStats(diametersUm || diametersPx);
  const unitLabel = micronsPerPixel ? "µm" : "px";

  statsBox.innerHTML = `
    <span class="label">Count</span><strong>${stats.n}</strong>
    <span class="label">Mean</span><strong>${stats.mean.toFixed(2)} ${unitLabel}</strong>
    <span class="label">Std dev</span><strong>${stats.std.toFixed(2)} ${unitLabel}</strong>
    <span class="label">Median</span><strong>${stats.median.toFixed(2)} ${unitLabel}</strong>
    <span class="label">Min</span><strong>${stats.min.toFixed(2)} ${unitLabel}</strong>
    <span class="label">Max</span><strong>${stats.max.toFixed(2)} ${unitLabel}</strong>
  `;
  statsBox.classList.remove("hidden");

  drawHistogram(diametersUm || diametersPx, unitLabel);
  histCanvas.classList.remove("hidden");

  resultsTableBody.innerHTML = circles
    .map((c, i) => {
      const dPx = (c.r * 2).toFixed(1);
      const dReal = micronsPerPixel ? (c.r * 2 * micronsPerPixel).toFixed(2) + " µm" : "—";
      return `<tr><td>${i + 1}</td><td>${dPx}</td><td>${dReal}</td></tr>`;
    })
    .join("");
  tableWrap.classList.remove("hidden");

  btnExport.classList.remove("hidden");

  renderContactResults();
}

function renderContactResults() {
  if (!contactPairs.length) {
    contactSection.classList.add("hidden");
    return;
  }
  contactSection.classList.remove("hidden");

  contactTableBody.innerHTML = contactPairs
    .map((p) => {
      const pairLabel = `${p.i + 1}–${p.j + 1}`;
      const angleCell = p.inContact3D ? p.angleDeg.toFixed(1) : "not in contact*";
      return `<tr><td>${pairLabel}</td><td>${(p.r1 * 2).toFixed(2)}</td><td>${(p.r2 * 2).toFixed(2)}</td><td>${p.dxy.toFixed(2)}</td><td>${p.D.toFixed(2)}</td><td>${angleCell}</td></tr>`;
    })
    .join("");
  contactTableWrap.classList.remove("hidden");
  btnExportContacts.classList.remove("hidden");
}

function computeStats(values) {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  const sorted = [...values].sort((a, b) => a - b);
  const median =
    n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  return { n, mean, std, median, min: sorted[0], max: sorted[n - 1] };
}

function drawHistogram(values, unitLabel) {
  const ctx = histCanvas.getContext("2d");
  const w = histCanvas.width;
  const h = histCanvas.height;
  ctx.clearRect(0, 0, w, h);

  const bins = Math.max(5, Math.min(20, Math.ceil(Math.sqrt(values.length))));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const binWidth = range / bins;
  const counts = new Array(bins).fill(0);
  values.forEach((v) => {
    const idx = Math.min(bins - 1, Math.floor((v - min) / binWidth));
    counts[idx]++;
  });
  const maxCount = Math.max(...counts);

  const padL = 34, padB = 18, padT = 6, padR = 6;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const barGap = 2;
  const barW = plotW / bins;

  const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  ctx.strokeStyle = isDark ? "#2a2f3a" : "#dde1e8";
  ctx.fillStyle = isDark ? "#9aa3b2" : "#5b6472";
  ctx.font = "10px sans-serif";

  // y-axis gridlines / labels
  const ySteps = 3;
  for (let i = 0; i <= ySteps; i++) {
    const y = padT + plotH - (plotH * i) / ySteps;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.fillText(Math.round((maxCount * i) / ySteps), 2, y + 3);
  }

  ctx.fillStyle = "#4f9dff";
  counts.forEach((count, i) => {
    const barH = maxCount ? (count / maxCount) * plotH : 0;
    const x = padL + i * barW + barGap / 2;
    const y = padT + plotH - barH;
    ctx.fillRect(x, y, barW - barGap, barH);
  });

  ctx.fillStyle = isDark ? "#9aa3b2" : "#5b6472";
  ctx.fillText(min.toFixed(1), padL, h - 4);
  ctx.textAlign = "right";
  ctx.fillText(max.toFixed(1) + " " + unitLabel, w - padR, h - 4);
  ctx.textAlign = "left";
}

function downloadCsv(filename, rows) {
  const blob = new Blob([rows.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

btnExport.addEventListener("click", () => {
  const rows = ["index,diameter_px,diameter_um"];
  circles.forEach((c, i) => {
    const dPx = (c.r * 2).toFixed(2);
    const dUm = micronsPerPixel ? (c.r * 2 * micronsPerPixel).toFixed(3) : "";
    rows.push(`${i + 1},${dPx},${dUm}`);
  });
  downloadCsv("droplet-diameters.csv", rows);
});

btnExportContacts.addEventListener("click", () => {
  const rows = ["droplet_1,droplet_2,diameter_1_um,diameter_2_um,apparent_distance_um,3d_distance_um,in_contact,angle_deg"];
  contactPairs.forEach((p) => {
    rows.push(
      [
        p.i + 1,
        p.j + 1,
        (p.r1 * 2).toFixed(3),
        (p.r2 * 2).toFixed(3),
        p.dxy.toFixed(3),
        p.D.toFixed(3),
        p.inContact3D ? "yes" : "no",
        p.inContact3D ? p.angleDeg.toFixed(2) : "",
      ].join(",")
    );
  });
  downloadCsv("droplet-contact-angles.csv", rows);
});

/* ==================== Video tab ==================== */

/* ---------- video state ---------- */
let videoLoaded = false;
let videoCalibrated = false;
let videoCalibMode = "draw"; // "draw" | "direct"
let videoMode = "idle"; // "idle" | "calibrating"
let videoCalibLine = null;
let videoMicronsPerPixel = null;
let videoProcessing = false;
let videoAbort = false;
let videoFrameResults = []; // [{timeSec, circles:[{x,y,r,trackId}], contactPairs}]

const CHART_COLORS = ["#4f9dff", "#4fd18b", "#ff9f4f", "#c77dff", "#ff5c5c", "#4fd1c5"];

/* ---------- video elements ---------- */
const videoDropZone = document.getElementById("videoDropZone");
const videoFileInput = document.getElementById("videoFileInput");
const videoStageWrap = document.getElementById("videoStageWrap");
const videoStageHint = document.getElementById("videoStageHint");
const videoEl = document.getElementById("videoEl");
const videoCanvas = document.getElementById("videoCanvas");
const videoOverlayCanvas = document.getElementById("videoOverlayCanvas");
const ctxVideoImg = videoCanvas.getContext("2d");
const ctxVideoOverlay = videoOverlayCanvas.getContext("2d");
const videoScrubWrap = document.getElementById("videoScrubWrap");
const videoScrubber = document.getElementById("videoScrubber");
const videoScrubHint = document.getElementById("videoScrubHint");

const videoCalibModeRadios = document.querySelectorAll('input[name="videoCalibMode"]');
const videoCalibDrawMode = document.getElementById("videoCalibDrawMode");
const videoCalibDirectMode = document.getElementById("videoCalibDirectMode");
const videoBtnDrawScale = document.getElementById("videoBtnDrawScale");
const videoCalibrateForm = document.getElementById("videoCalibrateForm");
const videoKnownLength = document.getElementById("videoKnownLength");
const videoKnownUnit = document.getElementById("videoKnownUnit");
const videoBtnConfirmScale = document.getElementById("videoBtnConfirmScale");
const videoDirectScaleValue = document.getElementById("videoDirectScaleValue");
const videoBtnConfirmDirectScale = document.getElementById("videoBtnConfirmDirectScale");
const videoScaleResult = document.getElementById("videoScaleResult");

const videoMinDiameterUm = document.getElementById("videoMinDiameterUm");
const videoMaxDiameterUm = document.getElementById("videoMaxDiameterUm");
const videoMinDistUm = document.getElementById("videoMinDistUm");
const videoParam1 = document.getElementById("videoParam1");
const videoParam2 = document.getElementById("videoParam2");
const sampleIntervalMs = document.getElementById("sampleIntervalMs");
const btnProcessVideo = document.getElementById("btnProcessVideo");
const videoProgressWrap = document.getElementById("videoProgressWrap");
const videoProgress = document.getElementById("videoProgress");
const videoProgressLabel = document.getElementById("videoProgressLabel");
const btnCancelVideo = document.getElementById("btnCancelVideo");

const angleChartCanvas = document.getElementById("angleChartCanvas");
const angleChartLegend = document.getElementById("angleChartLegend");
const videoContactTableWrap = document.getElementById("videoContactTableWrap");
const videoContactTableBody = document.querySelector("#videoContactTable tbody");
const btnExportVideoCsv = document.getElementById("btnExportVideoCsv");

[
  [videoParam1, "videoParam1Val", (v) => v],
  [videoParam2, "videoParam2Val", (v) => v],
].forEach(([input, labelId, transform]) => {
  const label = document.getElementById(labelId);
  const update = () => (label.textContent = transform(Number(input.value)));
  input.addEventListener("input", update);
  update();
});

/* ---------- video loading ---------- */
videoDropZone.addEventListener("click", () => videoFileInput.click());
videoDropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  videoDropZone.classList.add("dragover");
});
videoDropZone.addEventListener("dragleave", () => videoDropZone.classList.remove("dragover"));
videoDropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  videoDropZone.classList.remove("dragover");
  if (e.dataTransfer.files.length) loadVideoFile(e.dataTransfer.files[0]);
});
videoFileInput.addEventListener("change", () => {
  if (videoFileInput.files.length) loadVideoFile(videoFileInput.files[0]);
});

function loadVideoFile(file) {
  if (!file.type.startsWith("video/")) return;
  const url = URL.createObjectURL(file);
  videoEl.onloadedmetadata = () => {
    videoCanvas.width = videoEl.videoWidth;
    videoCanvas.height = videoEl.videoHeight;
    videoOverlayCanvas.width = videoEl.videoWidth;
    videoOverlayCanvas.height = videoEl.videoHeight;

    videoStageWrap.classList.remove("hidden");
    videoDropZone.classList.add("hidden");
    videoStageHint.textContent = `${videoEl.videoWidth} × ${videoEl.videoHeight} px, ${videoEl.duration.toFixed(2)}s`;

    videoLoaded = true;
    videoFrameResults = [];
    videoCalibLine = null;
    videoCalibrateForm.classList.add("hidden");
    videoScrubWrap.classList.add("hidden");
    resetVideoResults();

    // Same reasoning as the Analyze tab: a drawn line is tied to this
    // video's pixel coordinates, a directly-entered scale isn't.
    if (videoCalibMode === "draw") {
      videoCalibrated = false;
      videoMicronsPerPixel = null;
      videoScaleResult.classList.add("hidden");
    } else if (videoCalibrated) {
      videoScaleResult.textContent = `Scale set: 1 px = ${videoMicronsPerPixel.toFixed(4)} µm`;
      videoScaleResult.classList.remove("hidden");
    }

    seekVideoTo(0).then(() => {
      ctxVideoImg.drawImage(videoEl, 0, 0, videoCanvas.width, videoCanvas.height);
      ctxVideoOverlay.clearRect(0, 0, videoOverlayCanvas.width, videoOverlayCanvas.height);
    });

    videoBtnDrawScale.disabled = false;
    updateProcessButtonState();
  };
  videoEl.onerror = () => {
    videoStageHint.textContent = "Could not load that video file.";
  };
  videoEl.src = url;
}

// Resolves once the video has actually seeked to (approximately) time t and
// a frame is ready to read via drawImage. Guards against browsers not
// firing 'seeked' when currentTime is set to (approximately) where it
// already is.
function seekVideoTo(t) {
  const target = Math.min(Math.max(t, 0), Math.max(0, videoEl.duration - 0.001));
  return new Promise((resolve) => {
    if (Math.abs(videoEl.currentTime - target) < 0.005) {
      resolve();
      return;
    }
    const onSeeked = () => {
      videoEl.removeEventListener("seeked", onSeeked);
      resolve();
    };
    videoEl.addEventListener("seeked", onSeeked);
    videoEl.currentTime = target;
  });
}

/* ---------- video calibration (mirrors the Analyze tab) ---------- */
function videoEventToCanvasPoint(evt) {
  const rect = videoOverlayCanvas.getBoundingClientRect();
  const scaleX = videoOverlayCanvas.width / rect.width;
  const scaleY = videoOverlayCanvas.height / rect.height;
  return {
    x: (evt.clientX - rect.left) * scaleX,
    y: (evt.clientY - rect.top) * scaleY,
  };
}

videoBtnDrawScale.addEventListener("click", () => {
  videoMode = "calibrating";
  videoCalibLine = null;
  videoCalibrateForm.classList.add("hidden");
  videoScaleResult.classList.add("hidden");
  ctxVideoOverlay.clearRect(0, 0, videoOverlayCanvas.width, videoOverlayCanvas.height);
  videoStageHint.textContent = "Click and drag along a reference length, then release.";
});

let videoDragging = false;
let videoDragStart = null;

videoOverlayCanvas.addEventListener("mousedown", (e) => {
  if (videoMode !== "calibrating") return;
  videoDragging = true;
  videoDragStart = videoEventToCanvasPoint(e);
});

videoOverlayCanvas.addEventListener("mousemove", (e) => {
  if (videoMode !== "calibrating" || !videoDragging) return;
  const p = videoEventToCanvasPoint(e);
  ctxVideoOverlay.clearRect(0, 0, videoOverlayCanvas.width, videoOverlayCanvas.height);
  drawLineOn(ctxVideoOverlay, videoOverlayCanvas, videoDragStart, p);
});

videoOverlayCanvas.addEventListener("mouseup", (e) => {
  if (videoMode !== "calibrating" || !videoDragging) return;
  videoDragging = false;
  const p = videoEventToCanvasPoint(e);
  videoCalibLine = { x1: videoDragStart.x, y1: videoDragStart.y, x2: p.x, y2: p.y };
  ctxVideoOverlay.clearRect(0, 0, videoOverlayCanvas.width, videoOverlayCanvas.height);
  drawLineOn(ctxVideoOverlay, videoOverlayCanvas, videoDragStart, p);
  videoMode = "idle";
  const pxLen = Math.hypot(videoCalibLine.x2 - videoCalibLine.x1, videoCalibLine.y2 - videoCalibLine.y1);
  if (pxLen < 2) {
    videoStageHint.textContent = "Line too short — try drawing the scale line again.";
    videoCalibLine = null;
    return;
  }
  videoCalibrateForm.classList.remove("hidden");
  videoStageHint.textContent = `Line drawn: ${pxLen.toFixed(1)} px. Enter its real-world length.`;
});

function applyVideoCalibration(newMicronsPerPixel, hintText) {
  videoMicronsPerPixel = newMicronsPerPixel;
  videoCalibrated = true;
  videoScaleResult.textContent = `Scale set: 1 px = ${videoMicronsPerPixel.toFixed(4)} µm`;
  videoScaleResult.classList.remove("hidden");
  videoCalibrateForm.classList.add("hidden");
  videoStageHint.textContent = hintText;
  updateProcessButtonState();
}

videoBtnConfirmScale.addEventListener("click", () => {
  if (!videoCalibLine) return;
  const val = Number(videoKnownLength.value);
  if (!val || val <= 0) {
    videoKnownLength.focus();
    return;
  }
  const pxLen = Math.hypot(videoCalibLine.x2 - videoCalibLine.x1, videoCalibLine.y2 - videoCalibLine.y1);
  const realUm = unitToMicrons(val, videoKnownUnit.value);
  applyVideoCalibration(realUm / pxLen, "Scale calibrated from this frame.");
});

videoBtnConfirmDirectScale.addEventListener("click", () => {
  const val = Number(videoDirectScaleValue.value);
  if (!val || val <= 0) {
    videoDirectScaleValue.focus();
    return;
  }
  applyVideoCalibration(val, "Scale set directly.");
});

videoCalibModeRadios.forEach((radio) => {
  radio.addEventListener("change", () => {
    if (!radio.checked) return;
    videoCalibMode = radio.value;
    videoCalibDrawMode.classList.toggle("hidden", videoCalibMode !== "draw");
    videoCalibDirectMode.classList.toggle("hidden", videoCalibMode !== "direct");
  });
});

/* ---------- cross-frame tracking ---------- */
// Greedy nearest-neighbor matching, not a globally-optimal assignment
// (e.g. Hungarian algorithm) — adequate for short clips with well-spaced,
// slow-moving droplets, but can mis-track under fast motion or droplets
// crossing paths.
//
// Tracks "coast" for a couple of frames when a droplet goes briefly
// undetected (e.g. one weak-contrast frame under uneven illumination),
// instead of losing its identity — without this, a single missed frame
// would make a reappearing droplet look like a brand-new one, silently
// splitting one continuous droplet's angle-vs-time data into two
// disconnected series. `activeTracks` is mutated in place and carried
// across the whole processing run; nextIdRef is a mutable {value}
// counter so track IDs stay unique.
const TRACK_COAST_FRAMES = 2;

function updateTracks(newCircles, activeTracks, nextIdRef) {
  const usedTracks = new Set();

  const result = newCircles.map((c) => {
    let bestIdx = -1;
    let bestDist = Infinity;
    activeTracks.forEach((track, idx) => {
      if (usedTracks.has(idx)) return;
      const dist = Math.hypot(c.x - track.x, c.y - track.y);
      const gate = Math.max(c.r, track.r) * 1.5 + 10; // allow for motion + small-radius slack
      if (dist < gate && dist < bestDist) {
        bestDist = dist;
        bestIdx = idx;
      }
    });
    if (bestIdx >= 0) {
      usedTracks.add(bestIdx);
      const track = activeTracks[bestIdx];
      track.x = c.x;
      track.y = c.y;
      track.r = c.r;
      track.framesSinceSeen = 0;
      return { ...c, trackId: track.trackId };
    }
    const trackId = nextIdRef.value++;
    activeTracks.push({ trackId, x: c.x, y: c.y, r: c.r, framesSinceSeen: 0 });
    return { ...c, trackId };
  });

  // Age out tracks not matched this frame; drop ones that have coasted
  // too long without a real detection. Iterate backward so splicing
  // doesn't disturb indices already recorded in usedTracks.
  for (let i = activeTracks.length - 1; i >= 0; i--) {
    if (usedTracks.has(i)) continue;
    activeTracks[i].framesSinceSeen++;
    if (activeTracks[i].framesSinceSeen > TRACK_COAST_FRAMES) {
      activeTracks.splice(i, 1);
    }
  }

  return result;
}

function pairTrackLabel(frame, pair) {
  const a = frame.circles[pair.i].trackId;
  const b = frame.circles[pair.j].trackId;
  return `${Math.min(a, b)}–${Math.max(a, b)}`;
}
function pairTrackKey(frame, pair) {
  const a = frame.circles[pair.i].trackId;
  const b = frame.circles[pair.j].trackId;
  return `${Math.min(a, b)}-${Math.max(a, b)}`;
}

/* ---------- processing ---------- */
function updateProcessButtonState() {
  btnProcessVideo.disabled = !(cvReady && videoLoaded && videoCalibrated) || videoProcessing;
  btnProcessVideo.title = !cvReady
    ? "Waiting for OpenCV.js to load…"
    : !videoLoaded
    ? "Upload a video first"
    : !videoCalibrated
    ? "Calibrate the scale first"
    : "";
}

btnProcessVideo.addEventListener("click", () => {
  if (btnProcessVideo.disabled) return;
  processVideo();
});

btnCancelVideo.addEventListener("click", () => {
  videoAbort = true;
});

async function processVideo() {
  videoProcessing = true;
  videoAbort = false;
  updateProcessButtonState();
  videoProgressWrap.classList.remove("hidden");
  videoScrubWrap.classList.add("hidden");
  resetVideoResults();

  const interval = Math.max(10, Number(sampleIntervalMs.value)) / 1000; // seconds
  const duration = videoEl.duration;
  const timestamps = [];
  for (let t = 0; t < duration; t += interval) timestamps.push(t);
  timestamps.push(duration);

  const opts = {
    minDiameterUm: Number(videoMinDiameterUm.value),
    maxDiameterUm: Number(videoMaxDiameterUm.value),
    minDistUm: Number(videoMinDistUm.value),
    param1: Number(videoParam1.value),
    param2: Number(videoParam2.value),
    micronsPerPixel: videoMicronsPerPixel,
  };

  videoFrameResults = [];
  const activeTracks = [];
  const nextIdRef = { value: 1 };

  for (let idx = 0; idx < timestamps.length; idx++) {
    if (videoAbort) break;
    const t = timestamps[idx];
    await seekVideoTo(t);
    ctxVideoImg.drawImage(videoEl, 0, 0, videoCanvas.width, videoCanvas.height);

    const rawCircles = detectCirclesOnCanvas(videoCanvas, opts);
    const tracked = updateTracks(rawCircles, activeTracks, nextIdRef);
    const framePairs = computeContactPairsFor(tracked, videoMicronsPerPixel);

    videoFrameResults.push({ timeSec: t, circles: tracked, contactPairs: framePairs });

    const pct = Math.round(((idx + 1) / timestamps.length) * 100);
    videoProgress.value = pct;
    videoProgressLabel.textContent = `${idx + 1} / ${timestamps.length} samples (${pct}%)`;

    // Yield so the progress bar actually repaints between frames instead
    // of the UI freezing until the whole loop finishes.
    await new Promise((r) => setTimeout(r, 0));
  }

  videoProcessing = false;
  updateProcessButtonState();
  videoProgressWrap.classList.add("hidden");

  if (videoFrameResults.length) {
    videoScrubber.max = String(videoFrameResults.length - 1);
    videoScrubber.value = "0";
    videoScrubWrap.classList.remove("hidden");
    showVideoFrame(0);
    renderAngleChart();
    renderVideoContactTable();
  }
}

/* ---------- scrubber ---------- */
videoScrubber.addEventListener("input", () => {
  showVideoFrame(Number(videoScrubber.value));
});

function showVideoFrame(idx) {
  const frame = videoFrameResults[idx];
  if (!frame) return;
  videoScrubHint.textContent = `Sample ${idx + 1} / ${videoFrameResults.length} — t = ${frame.timeSec.toFixed(2)}s — ${frame.circles.length} droplet(s) detected`;
  seekVideoTo(frame.timeSec).then(() => {
    ctxVideoImg.drawImage(videoEl, 0, 0, videoCanvas.width, videoCanvas.height);
    ctxVideoOverlay.clearRect(0, 0, videoOverlayCanvas.width, videoOverlayCanvas.height);
    drawCirclesOn(ctxVideoOverlay, videoOverlayCanvas, frame.circles);
    drawContactPairsOn(ctxVideoOverlay, videoOverlayCanvas, frame.circles, frame.contactPairs);
  });
}

/* ---------- results: chart, table, csv ---------- */
function resetVideoResults() {
  angleChartCanvas.classList.add("hidden");
  angleChartLegend.innerHTML = "";
  videoContactTableWrap.classList.add("hidden");
  btnExportVideoCsv.classList.add("hidden");
  videoContactTableBody.innerHTML = "";
}

function renderAngleChart() {
  const seriesMap = new Map(); // key -> {label, points:[{t,angle}]}
  videoFrameResults.forEach((frame) => {
    frame.contactPairs.forEach((pair) => {
      if (!pair.inContact3D) return;
      const key = pairTrackKey(frame, pair);
      if (!seriesMap.has(key)) seriesMap.set(key, { label: pairTrackLabel(frame, pair), points: [] });
      seriesMap.get(key).points.push({ t: frame.timeSec, angle: pair.angleDeg });
    });
  });

  const series = [...seriesMap.values()];
  angleChartCanvas.classList.toggle("hidden", series.length === 0);
  if (!series.length) return;
  drawAngleChart(series);

  angleChartLegend.innerHTML = series
    .map(
      (s, i) =>
        `<span><span class="swatch" style="background:${CHART_COLORS[i % CHART_COLORS.length]}"></span>Pair ${s.label}</span>`
    )
    .join("");
}

function drawAngleChart(series) {
  const ctx = angleChartCanvas.getContext("2d");
  const w = angleChartCanvas.width;
  const h = angleChartCanvas.height;
  ctx.clearRect(0, 0, w, h);

  const allT = series.flatMap((s) => s.points.map((p) => p.t));
  const tMax = Math.max(...allT, 0.001);
  const aMax = 180;

  const padL = 30, padB = 20, padT = 8, padR = 8;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  ctx.strokeStyle = isDark ? "#2a2f3a" : "#dde1e8";
  ctx.fillStyle = isDark ? "#9aa3b2" : "#5b6472";
  ctx.font = "10px sans-serif";

  const ySteps = 4;
  for (let i = 0; i <= ySteps; i++) {
    const y = padT + plotH - (plotH * i) / ySteps;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.fillText(Math.round((aMax * i) / ySteps), 2, y + 3);
  }
  ctx.fillText("0s", padL, h - 4);
  ctx.textAlign = "right";
  ctx.fillText(tMax.toFixed(1) + "s", w - padR, h - 4);
  ctx.textAlign = "left";

  const xFor = (t) => padL + (t / tMax) * plotW;
  const yFor = (a) => padT + plotH - (a / aMax) * plotH;

  series.forEach((s, idx) => {
    const color = CHART_COLORS[idx % CHART_COLORS.length];
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    s.points.forEach((p, i) => {
      const x = xFor(p.t);
      const y = yFor(p.angle);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = color;
    s.points.forEach((p) => {
      ctx.beginPath();
      ctx.arc(xFor(p.t), yFor(p.angle), 2.5, 0, 2 * Math.PI);
      ctx.fill();
    });
  });
}

function renderVideoContactTable() {
  const rows = [];
  videoFrameResults.forEach((frame) => {
    frame.contactPairs.forEach((pair) => {
      const label = pairTrackLabel(frame, pair);
      const angleCell = pair.inContact3D ? pair.angleDeg.toFixed(1) : "not in contact";
      rows.push(`<tr><td>${frame.timeSec.toFixed(2)}</td><td>${label}</td><td>${angleCell}</td></tr>`);
    });
  });
  videoContactTableBody.innerHTML = rows.join("");
  videoContactTableWrap.classList.toggle("hidden", rows.length === 0);
  btnExportVideoCsv.classList.toggle("hidden", rows.length === 0);
}

btnExportVideoCsv.addEventListener("click", () => {
  const rows = [
    "time_s,pair,diameter_1_um,diameter_2_um,apparent_distance_um,3d_distance_um,in_contact,angle_deg",
  ];
  videoFrameResults.forEach((frame) => {
    frame.contactPairs.forEach((pair) => {
      const label = pairTrackKey(frame, pair);
      rows.push(
        [
          frame.timeSec.toFixed(3),
          label,
          (pair.r1 * 2).toFixed(3),
          (pair.r2 * 2).toFixed(3),
          pair.dxy.toFixed(3),
          pair.D.toFixed(3),
          pair.inContact3D ? "yes" : "no",
          pair.inContact3D ? pair.angleDeg.toFixed(2) : "",
        ].join(",")
      );
    });
  });
  downloadCsv("droplet-contact-angle-vs-time.csv", rows);
});
