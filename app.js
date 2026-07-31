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

  const src = cv.imread(imgCanvas);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, gray, new cv.Size(9, 9), 2, 2);

  // Detection controls are entered in real-world length units (µm);
  // convert to pixel radii/distance here using the calibrated scale.
  const detected = new cv.Mat();
  const minR = Number(minDiameterUm.value) / micronsPerPixel / 2;
  const maxR = Number(maxDiameterUm.value) / micronsPerPixel / 2;
  const minDistPx = Number(minDistUm.value) / micronsPerPixel;
  cv.HoughCircles(
    gray,
    detected,
    cv.HOUGH_GRADIENT,
    1,             // dp
    minDistPx,     // minDist between centers
    Number(param1.value), // Canny high threshold
    Number(param2.value), // accumulator threshold
    Math.min(minR, maxR), // minRadius
    Math.max(minR, maxR)  // maxRadius
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

  contactPairs = computeContactPairs();

  ctxOverlay.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  redrawCircles();
  drawContactPairs();
  renderResults();
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
  const pairs = [];
  for (let i = 0; i < circles.length; i++) {
    for (let j = i + 1; j < circles.length; j++) {
      const a = circles[i];
      const b = circles[j];
      const distPx = Math.hypot(b.x - a.x, b.y - a.y);
      if (distPx >= a.r + b.r) continue; // apparent circles don't overlap

      const r1 = a.r * micronsPerPixel;
      const r2 = b.r * micronsPerPixel;
      const dxy = distPx * micronsPerPixel; // apparent lateral separation
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
  if (!contactPairs.length) return;
  const fontSize = Math.max(11, overlayCanvas.width / 85);
  ctxOverlay.font = `${fontSize}px sans-serif`;
  ctxOverlay.textAlign = "center";
  ctxOverlay.textBaseline = "middle";
  ctxOverlay.lineWidth = Math.max(1.5, overlayCanvas.width / 700);

  contactPairs.forEach((pair) => {
    const a = circles[pair.i];
    const b = circles[pair.j];
    ctxOverlay.strokeStyle = pair.inContact3D ? "#4fd18b" : "#9aa3b2";
    ctxOverlay.setLineDash(pair.inContact3D ? [] : [5, 4]);
    ctxOverlay.beginPath();
    ctxOverlay.moveTo(a.x, a.y);
    ctxOverlay.lineTo(b.x, b.y);
    ctxOverlay.stroke();
    ctxOverlay.setLineDash([]);

    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const label = pair.inContact3D ? `${pair.angleDeg.toFixed(1)}°` : "n/c";
    ctxOverlay.lineWidth = Math.max(2, fontSize / 5);
    ctxOverlay.strokeStyle = "black";
    ctxOverlay.strokeText(label, midX, midY);
    ctxOverlay.fillStyle = pair.inContact3D ? "#4fd18b" : "#9aa3b2";
    ctxOverlay.fillText(label, midX, midY);
    ctxOverlay.lineWidth = Math.max(1.5, overlayCanvas.width / 700);
  });
}

function redrawCircles() {
  const fontSize = Math.max(12, overlayCanvas.width / 70);
  ctxOverlay.lineWidth = Math.max(2, overlayCanvas.width / 500);
  ctxOverlay.font = `bold ${fontSize}px sans-serif`;
  ctxOverlay.textAlign = "center";
  ctxOverlay.textBaseline = "middle";

  circles.forEach((c, i) => {
    ctxOverlay.strokeStyle = "#ff5c5c";
    ctxOverlay.beginPath();
    ctxOverlay.arc(c.x, c.y, c.r, 0, 2 * Math.PI);
    ctxOverlay.stroke();

    // Index label matches the results table row, so a droplet can be
    // found in the image from its row (or vice versa).
    const label = String(i + 1);
    ctxOverlay.lineWidth = Math.max(2, fontSize / 5);
    ctxOverlay.strokeStyle = "black";
    ctxOverlay.strokeText(label, c.x, c.y);
    ctxOverlay.fillStyle = "#ff5c5c";
    ctxOverlay.fillText(label, c.x, c.y);
    ctxOverlay.lineWidth = Math.max(2, overlayCanvas.width / 500);
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
