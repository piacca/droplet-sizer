"use strict";

/* ---------- state ---------- */
let cvReady = false;
let imgLoaded = false;
let calibrated = false;
let mode = "idle"; // "idle" | "calibrating"
let calibLine = null; // {x1,y1,x2,y2} in natural image pixel coords
let micronsPerPixel = null;
let circles = []; // [{x, y, r}] in natural image pixel coords

/* ---------- elements ---------- */
const dropZone = document.getElementById("dropZone");
const fileInput = document.getElementById("fileInput");
const stageWrap = document.getElementById("stageWrap");
const stageHint = document.getElementById("stageHint");
const imgCanvas = document.getElementById("imgCanvas");
const overlayCanvas = document.getElementById("overlayCanvas");
const ctxImg = imgCanvas.getContext("2d");
const ctxOverlay = overlayCanvas.getContext("2d");

const btnDrawScale = document.getElementById("btnDrawScale");
const calibrateForm = document.getElementById("calibrateForm");
const knownLength = document.getElementById("knownLength");
const knownUnit = document.getElementById("knownUnit");
const btnConfirmScale = document.getElementById("btnConfirmScale");
const scaleResult = document.getElementById("scaleResult");

const minRadius = document.getElementById("minRadius");
const maxRadius = document.getElementById("maxRadius");
const minDist = document.getElementById("minDist");
const param1 = document.getElementById("param1");
const param2 = document.getElementById("param2");
const btnDetect = document.getElementById("btnDetect");

const statsBox = document.getElementById("statsBox");
const histCanvas = document.getElementById("histCanvas");
const tableWrap = document.getElementById("tableWrap");
const resultsTableBody = document.querySelector("#resultsTable tbody");
const btnExport = document.getElementById("btnExport");

const loadingOverlay = document.getElementById("loadingOverlay");

/* ---------- opencv.js bootstrap ---------- */
loadingOverlay.classList.remove("hidden");

function onOpenCvReady() {
  cv["onRuntimeInitialized"] = () => {
    cvReady = true;
    loadingOverlay.classList.add("hidden");
    updateDetectButtonState();
  };
}
window.onOpenCvReady = onOpenCvReady;

/* ---------- slider label wiring ---------- */
[
  [minRadius, "minRadiusVal", (v) => v * 2],
  [maxRadius, "maxRadiusVal", (v) => v * 2],
  [minDist, "minDistVal", (v) => v],
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
  calibrated = false;
  micronsPerPixel = null;
  circles = [];
  calibLine = null;
  scaleResult.classList.add("hidden");
  calibrateForm.classList.add("hidden");
  resetResults();

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
  ctxOverlay.strokeStyle = "#4f9dff";
  ctxOverlay.lineWidth = Math.max(2, overlayCanvas.width / 500);
  ctxOverlay.beginPath();
  ctxOverlay.moveTo(p1.x, p1.y);
  ctxOverlay.lineTo(p2.x, p2.y);
  ctxOverlay.stroke();
}

function unitToMicrons(value, unit) {
  switch (unit) {
    case "nm": return value / 1000;
    case "mm": return value * 1000;
    default: return value; // um
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
  micronsPerPixel = realUm / pxLen;
  calibrated = true;
  scaleResult.textContent = `Scale set: 1 px = ${micronsPerPixel.toFixed(4)} µm`;
  scaleResult.classList.remove("hidden");
  calibrateForm.classList.add("hidden");
  stageHint.textContent = "Scale calibrated. You can redraw it any time.";
  updateDetectButtonState();
  if (circles.length) renderResults(); // refresh units if detection already ran
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

  const src = cv.imread(imgCanvas);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, gray, new cv.Size(9, 9), 2, 2);

  const detected = new cv.Mat();
  const minR = Number(minRadius.value);
  const maxR = Number(maxRadius.value);
  cv.HoughCircles(
    gray,
    detected,
    cv.HOUGH_GRADIENT,
    1,                      // dp
    Number(minDist.value),  // minDist between centers
    Number(param1.value),   // Canny high threshold
    Number(param2.value),   // accumulator threshold
    Math.min(minR, maxR),   // minRadius
    Math.max(minR, maxR)    // maxRadius
  );

  circles = [];
  for (let i = 0; i < detected.cols; i++) {
    const x = detected.data32F[i * 3];
    const y = detected.data32F[i * 3 + 1];
    const r = detected.data32F[i * 3 + 2];
    circles.push({ x, y, r });
  }

  src.delete();
  gray.delete();
  detected.delete();

  ctxOverlay.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  redrawCircles();
  renderResults();
}

function redrawCircles() {
  ctxOverlay.strokeStyle = "#ff5c5c";
  ctxOverlay.lineWidth = Math.max(2, overlayCanvas.width / 500);
  circles.forEach((c) => {
    ctxOverlay.beginPath();
    ctxOverlay.arc(c.x, c.y, c.r, 0, 2 * Math.PI);
    ctxOverlay.stroke();
    ctxOverlay.beginPath();
    ctxOverlay.fillStyle = "#ff5c5c";
    ctxOverlay.arc(c.x, c.y, Math.max(2, overlayCanvas.width / 400), 0, 2 * Math.PI);
    ctxOverlay.fill();
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

btnExport.addEventListener("click", () => {
  const unitLabel = micronsPerPixel ? "um" : "px";
  const rows = ["index,diameter_px,diameter_um"];
  circles.forEach((c, i) => {
    const dPx = (c.r * 2).toFixed(2);
    const dUm = micronsPerPixel ? (c.r * 2 * micronsPerPixel).toFixed(3) : "";
    rows.push(`${i + 1},${dPx},${dUm}`);
  });
  const csv = rows.join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `droplet-diameters.csv`;
  a.click();
  URL.revokeObjectURL(url);
});
