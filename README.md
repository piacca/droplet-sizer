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
