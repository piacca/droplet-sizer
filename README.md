# Droplet Sizer

A browser-based tool for measuring water-in-oil droplet diameters from microscopy images. Everything runs client-side (via [OpenCV.js](https://docs.opencv.org/4.x/df/d0a/tutorial_js_intro.html)) — no images are uploaded to a server, so it works entirely offline once loaded and can be hosted for free as a static site (e.g. GitHub Pages).

## Usage

1. Open `index.html` (or the hosted URL) in a browser.
2. **Upload** a microscopy image (PNG/JPG/TIFF).
3. **Calibrate the scale**, either way:
   - **Draw scale bar on image**: drag along a reference of known length (e.g. a scale bar on the image), then enter that real-world length and unit. Tied to this specific image's pixel coordinates, so it needs redoing for each new image.
   - **Enter known scale**: type your microscope/camera's known µm-per-pixel calibration directly (e.g. from a calibration slide or objective spec sheet). Since it doesn't depend on the image, it stays applied across every image you upload afterward — no redoing it each time.
4. **Tune detection**: set the expected min/max diameter and minimum spacing between droplets in µm (using your calibrated scale), adjust the edge-sensitivity/strictness sliders, and click "Run detection". Detected droplets are outlined in red and numbered on the image, matching the row numbers in the results table.
5. **Review results**: summary statistics, a diameter histogram, and a per-droplet table appear. Click "Download diameters CSV" to export all measured diameters (in both pixels and µm).
6. **Contact angles**: for any pair of detected droplets whose circles overlap in the image, a contact angle is computed automatically and shown as a labeled line between them (green = the pair is actually touching in 3D per the model below; grey dashed = it looks like overlap in 2D but isn't real contact once height is accounted for). A table and "Download contact angles CSV" appear below the diameter table. See below for the model this is based on.

Detection uses a [Hough Circle Transform](https://docs.opencv.org/4.x/d3/de5/tutorial_js_houghcircles.html), which works best on droplets that are reasonably circular, in focus, and not too heavily overlapping. If results are off, re-tune the sliders and re-run — no need to re-upload or re-calibrate.

Before detection, each image (and each sampled video frame) has its grayscale contrast automatically stretched to fill the full brightness range. This makes detection far more robust to images/videos with inconsistent brightness — e.g. footage alternating between different illumination sources — without needing separate detection settings per lighting condition.

Detected circles are also passed through a duplicate-suppression pass: lowering "min distance between centers" to catch legitimately close/touching droplets can also let Hough report two slightly different circles fit to the same blurry droplet edge. Near-perfectly-coincident detections (tight relative to droplet size) are merged, while genuinely distinct droplets — even touching or overlapping ones — are left alone, since their centers are still separated by roughly their combined radii, not a few pixels of fit jitter.

## Video tab

Measures contact angle *over time* from a video of droplets interacting, using the same detection/contact-angle machinery as the image tool, applied to a series of sampled frames.

1. **Upload** a video (any format your browser can play).
2. **Calibrate the scale**, same two options as the image tool, applied to the first frame.
3. **Detection settings**: same parameters as the image tool, plus a **sample interval** — browsers don't expose a reliable frame-by-frame API for arbitrary video files, so the video is sampled at this time interval via seeking rather than read frame-by-frame. A smaller interval gives more data points but takes longer to process. It's worth tuning detection settings against the first frame's static image feel before processing the whole video.
4. **Process video**: runs detection on every sampled frame, then matches detected droplets across frames (nearest position/size, gated by a maximum plausible movement per frame) so the same physical droplet keeps the same identity as it moves — a simple greedy nearest-neighbor matcher, not a globally-optimal assignment, so it can mis-track under fast motion or droplets crossing paths. A track tolerates a droplet going undetected for up to 2 consecutive samples (e.g. one weak-contrast frame) without losing its identity, so an isolated missed detection doesn't fragment one droplet's data into two disconnected series.
5. **Scrub** through processed frames with the slider to see the detected circles and contact-angle line for each sampled instant.
6. **Results**: an angle-vs-time chart (one line per tracked droplet pair, colored consistently with the legend), a per-sample table, and "Download angle-vs-time CSV".

## Running locally

This is a static site with no build step. Any local web server works, e.g.:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`. (Opening `index.html` directly via `file://` can hit browser restrictions on loading OpenCV.js — a local server avoids that.)

## Limitations

- Detection is circle-based; well-separated and moderately overlapping droplets work best. Heavily overlapping/merged droplets are unreliable — see the overlap tuning tips below.
- Scale calibration and detection parameters are per-image; batch processing across many images isn't supported yet.
- Accuracy depends on image quality (focus, contrast, scale bar clarity).
- TIFF support ([UTIF.js](https://github.com/photopea/UTIF.js)) is decoded entirely client-side. Only the first frame of a multi-page/stack TIFF is used. Common 8-bit and 16-bit grayscale scientific TIFFs are supported, but unusual variants (e.g. some OME-TIFF metadata, float samples) may not decode correctly — if a TIFF fails or looks wrong, try re-exporting as PNG (e.g. in ImageJ/Fiji: File → Save As → PNG) as a fallback.
- Video sampling is time-based (via seeking), not literal frame-by-frame — the x-axis of the angle-vs-time chart is time, not frame number, and very short/fast events between samples can be missed. Cross-frame droplet tracking is a simple nearest-neighbor matcher (with brief coasting through missed detections) and can mis-track under fast motion or crossing droplets.
- Detection quality can still vary frame-to-frame with real footage — contrast normalization and track coasting help, but a single fixed detection threshold won't be equally well-tuned for every frame of highly variable footage. The scrubber shows how many droplets were detected in each sampled frame so problem frames are easy to spot.

## Tips for overlapping droplets

The Hough Circle Transform detects circles from edge arcs, not full silhouettes, so it tolerates *partial* overlap reasonably well without any changes. If overlapping droplets are being missed or merged:

- Lower **"min distance between centers"** — a high value actively suppresses detecting two droplets whose centers are close together.
- Lower **"detection strictness"** — overlapping droplets have less visible edge arc, so they generate a weaker signal and need a lower threshold to register.
- Narrow the min/max diameter range around your droplets' actual size — this reduces false positives that a lower strictness threshold would otherwise let through.

For *heavily* overlapping/merged droplets where individual boundaries are barely visible, circle-fitting approaches (including this one) fundamentally struggle — that needs a different algorithm (e.g. watershed segmentation), not just parameter tuning.

## Contact angle model

For droplets resting on a shared horizontal substrate (e.g. settled on a glass slide under gravity) and imaged from directly above, the tool estimates the geometric contact angle between overlapping pairs, correcting for the fact that droplets of different sizes sit at different heights.

**Model and assumptions:**

- Each droplet is treated as an undeformed sphere resting tangent to the substrate — not flattened by gravity or by contact with its neighbor.
- Because of that tangency, a droplet's center sits at height *z = r* above the substrate (basic tangent-sphere geometry). Two droplets of different radii therefore have centers at different heights *purely because of the size difference* — this is the "different focal planes" effect.
- The apparent radii and center-to-center distance measured from the 2D image (r₁, r₂, d_xy) are treated as the true values, assuming a roughly telecentric/low-distortion imaging setup (standard for droplet size measurement — this is also what the diameter measurements elsewhere in the tool already assume).
- The true 3D center-to-center distance is reconstructed as D = √(d_xy² + (r₁−r₂)²).
- The contact angle is derived from the standard two-sphere intersection geometry: θ = arccos[(D² − r₁² − r₂²) / (2·r₁·r₂)]. This is defined so θ = 0° for droplets just grazing each other and grows as they overlap/adhere more — the conventional direction for a droplet-droplet contact/adhesion angle (e.g. as used in droplet-interface-bilayer literature). It's the supplement of the raw angle between the two center-to-contact-point lines.
- If D turns out to exceed r₁+r₂, the pair only *appears* to overlap in the 2D image (because of the height difference) but isn't actually in 3D contact under this model — reported as "not in contact" rather than a fabricated angle.

**Limitations:** this is a single-image, single-focal-plane model — it has no way to detect real deviations from a perfect sphere (e.g. gravitational sagging for larger droplets, or flattening from being pressed against a neighbor), and assumes every droplet in the frame is resting on the same substrate. If you need to relax the spherical-cap assumption, that would require z-stack imaging to directly measure each droplet's true height rather than inferring it from radius.

## License

MIT — see [LICENSE](LICENSE).
