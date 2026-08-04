"use strict";

/* ---------- state ---------- */
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

// Only one of these two result panels exists on a given page (Size
// Determination has the stats/histogram/table, Contact Angle Measurement
// has the contact section) — everything below is guarded accordingly so
// this one script works unmodified on both pages.
const statsBox = document.getElementById("statsBox");
const histCanvas = document.getElementById("histCanvas");
const tableWrap = document.getElementById("tableWrap");
const resultsTableBody = document.querySelector("#resultsTable tbody");
const btnExport = document.getElementById("btnExport");
const btnExportXlsx = document.getElementById("btnExportXlsx");

const contactSection = document.getElementById("contactSection");
const contactTableWrap = document.getElementById("contactTableWrap");
const contactTableBody = document.querySelector("#contactTable tbody");
const btnExportContacts = document.getElementById("btnExportContacts");
const btnExportContactsXlsx = document.getElementById("btnExportContactsXlsx");

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
  drawLineOn(ctxOverlay, overlayCanvas, dragStart, p);
});

overlayCanvas.addEventListener("mouseup", (e) => {
  if (mode !== "calibrating" || !dragging) return;
  dragging = false;
  const p = eventToCanvasPoint(e);
  calibLine = { x1: dragStart.x, y1: dragStart.y, x2: p.x, y2: p.y };
  ctxOverlay.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  redrawCircles();
  drawLineOn(ctxOverlay, overlayCanvas, dragStart, p);
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
    if (contactSection) drawContactPairs();
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
  if (contactSection) drawContactPairs();
  renderResults();
}

function computeContactPairs() {
  return computeContactPairsFor(circles, micronsPerPixel);
}

function drawContactPairs() {
  drawContactPairsOn(ctxOverlay, overlayCanvas, circles, contactPairs);
}

function redrawCircles() {
  drawCirclesOn(ctxOverlay, overlayCanvas, circles);
}

/* ---------- results: stats, table, histogram, csv ---------- */
function resetResults() {
  if (statsBox) {
    statsBox.classList.add("hidden");
    histCanvas.classList.add("hidden");
    tableWrap.classList.add("hidden");
    btnExport.classList.add("hidden");
    if (btnExportXlsx) btnExportXlsx.classList.add("hidden");
    statsBox.innerHTML = "";
    resultsTableBody.innerHTML = "";
  }
  if (contactSection) {
    contactSection.classList.add("hidden");
    contactTableWrap.classList.add("hidden");
    btnExportContacts.classList.add("hidden");
    if (btnExportContactsXlsx) btnExportContactsXlsx.classList.add("hidden");
    contactTableBody.innerHTML = "";
  }
}

function renderResults() {
  if (!circles.length) {
    resetResults();
    return;
  }

  if (statsBox) {
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
    if (btnExportXlsx) btnExportXlsx.classList.remove("hidden");
  }

  renderContactResults();
}

function renderContactResults() {
  if (!contactSection) return;
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
  if (btnExportContactsXlsx) btnExportContactsXlsx.classList.remove("hidden");
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

  ctx.strokeStyle = "#c7cedb";
  ctx.fillStyle = "#4b5563";
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

  ctx.fillStyle = "#14448f";
  counts.forEach((count, i) => {
    const barH = maxCount ? (count / maxCount) * plotH : 0;
    const x = padL + i * barW + barGap / 2;
    const y = padT + plotH - barH;
    ctx.fillRect(x, y, barW - barGap, barH);
  });

  ctx.fillStyle = "#4b5563";
  ctx.fillText(min.toFixed(1), padL, h - 4);
  ctx.textAlign = "right";
  ctx.fillText(max.toFixed(1) + " " + unitLabel, w - padR, h - 4);
  ctx.textAlign = "left";
}

function diametersAoa() {
  const header = ["Index", "Diameter (px)", "Diameter (µm)"];
  const rows = circles.map((c, i) => [
    i + 1,
    Number((c.r * 2).toFixed(2)),
    micronsPerPixel ? Number((c.r * 2 * micronsPerPixel).toFixed(3)) : "",
  ]);
  return [header, ...rows];
}

if (btnExport) {
  btnExport.addEventListener("click", () => {
    const rows = ["index,diameter_px,diameter_um"];
    circles.forEach((c, i) => {
      const dPx = (c.r * 2).toFixed(2);
      const dUm = micronsPerPixel ? (c.r * 2 * micronsPerPixel).toFixed(3) : "";
      rows.push(`${i + 1},${dPx},${dUm}`);
    });
    downloadCsv("droplet-diameters.csv", rows);
  });
}

if (btnExportXlsx) {
  btnExportXlsx.addEventListener("click", () => {
    downloadXlsx("droplet-diameters.xlsx", "Diameters", diametersAoa());
  });
}

function contactAnglesAoa() {
  const header = [
    "Droplet 1",
    "Droplet 2",
    "Diameter 1 (µm)",
    "Diameter 2 (µm)",
    "Apparent Distance (µm)",
    "3D Distance (µm)",
    "In Contact",
    "Angle (deg)",
  ];
  const rows = contactPairs.map((p) => [
    p.i + 1,
    p.j + 1,
    Number((p.r1 * 2).toFixed(3)),
    Number((p.r2 * 2).toFixed(3)),
    Number(p.dxy.toFixed(3)),
    Number(p.D.toFixed(3)),
    p.inContact3D ? "Yes" : "No",
    p.inContact3D ? Number(p.angleDeg.toFixed(2)) : "",
  ]);
  return [header, ...rows];
}

if (btnExportContacts) {
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
}

if (btnExportContactsXlsx) {
  btnExportContactsXlsx.addEventListener("click", () => {
    downloadXlsx("droplet-contact-angles.xlsx", "Contact Angles", contactAnglesAoa());
  });
}
