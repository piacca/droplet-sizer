"use strict";

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

const CHART_COLORS = ["#14448f", "#16875a", "#990000", "#c77dff", "#ff9f4f", "#4fd1c5"];

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

    // Same reasoning as the Size/Contact Angle pages: a drawn line is tied
    // to this video's pixel coordinates, a directly-entered scale isn't.
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

/* ---------- video calibration ---------- */
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

  ctx.strokeStyle = "#c7cedb";
  ctx.fillStyle = "#4b5563";
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
