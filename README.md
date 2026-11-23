# Canine Head Atlas

An interactive 3D study atlas of the canine (Labrador retriever) head, built for the
F&F 2 Practical Exam 2 terms list. Every label uses the exact wording of that list.

Open `index.html` through any static web server (GitHub Pages works as is).

## What it does

- Real CT skull and mandible, with 14 named bone regions.
- Layers, following the terms list:
  1. Bone, with fossae, foramina and fissures
  2. Nerves and blood vessels: a. superficial, b. deep
  3. Muscles and other structures: a. superficial, b. deep
- Views:
  - Whole head.
  - Bisected: split on the median plane, with the halves moved apart.
  - Tray: both halves laid cut-face up.
  - Each view can be rotated, zoomed and shown full screen (F).
- Search for any of the 271 terms. Selecting one turns its layer on and flies the camera to it.
- Quiz mode: numbered pins, reveal, and a running score.

## Sources and credits

- **Skull and mandible:** "Dog Skull", CT scan, NIH 3D Print Exchange 3DPX-000282 (public domain).
  - Decimated, split into cranium and mandible, and scaled to Labrador size.
  - The facial region is stretched to mesaticephalic proportions, checked against lab photographs.
- **Bone regions:** fitted from the segmented cranium of specimen CUHL 9 (Cornell University veterinary teaching collection).
  - Source: Hooker WC et al. 2025, "Explodable 3D Dog Skull for Veterinary Education", *MorphoMuseuM* 11(4), M3#1858/1859, free for educational use.
  - Only the bone labels were transferred; none of that specimen's geometry is included here.
- **Soft tissue:**
  - Modeled from the topography in Evans & de Lahunta, *Guide to the Dissection of the Dog*, and Hermanson, de Lahunta & Evans, *Miller and Evans' Anatomy of the Dog*.
  - These are schematic study models, not dissection scans.
- **Rendering:** [three.js](https://threejs.org) (MIT) and three-mesh-bvh (MIT), loaded from jsDelivr.

## Files

- `index.html`, `css/`, `js/`: the page.
- `data/terms.json`: the terms list (exact text, section, layer).
- `data/anchors.json`: where each term's pin sits.
- `data/structures.json`: geometry for nerves, vessels, muscles and glands.
- `assets/skull.glb.json`: the skull mesh, a GLB stored as base64 in JSON so it loads on any host.

For study use. Always check against your course materials and cadaver.
