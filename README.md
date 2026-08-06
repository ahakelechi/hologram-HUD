# HOLO // NEXUS

A volumetric point-cloud HUD. Runs as a Wallpaper Engine web wallpaper, or
as a plain web page on any PC without Wallpaper Engine.

The design rule throughout: **nothing moves on a timer.** Every animation is
a one-shot envelope fired by a real event — audio, the cursor, a network or
memory change. An idle screen is genuinely still, which is also what makes it
cheap to run. The two continuous motions (ring spin, subject turntable) are
opt-in and clearly marked.

## Files

| File | What it is |
|---|---|
| `holo-nexus-hud - Copy.html` | The whole wallpaper. Self-contained apart from the model data. |
| `holo-models.js` | Baked point clouds for every subject (~3.8 MB). |
| `project.json` | Wallpaper Engine property definitions. |
| `glb2holo.js` | Converts a `.glb` mesh into the baked point-cloud format. |
| `densify.js` | Adds points to an already-baked cloud that has no source mesh. |
| `STANDALONE.txt` | End-user instructions for running without Wallpaper Engine. |

## Running it

**Without Wallpaper Engine** — put `holo-nexus-hud - Copy.html` and
`holo-models.js` in the same folder and open the HTML in a browser. That's the
entire standalone package. See `STANDALONE.txt`.

Audio there comes from the microphone (click "ENABLE AUDIO"), because a web
page cannot read the system's audio output the way Wallpaper Engine can.

**With Wallpaper Engine** — the folder needs the HTML, `holo-models.js` and
`project.json` together. Every setting is exposed twice: in the in-page gear
panel, and as native Wallpaper Engine properties, because a desktop wallpaper
does not reliably receive mouse clicks.

## Settings

Roughly 60 controls, grouped: Subject, Colour, Background, Mouse & Look,
Audio, Panels & HUD, Optics, Ring, Turntable, Projector, Layout, Typography,
Performance. Surface presets set several at once.

Notable ones:

- **Paper backdrop** inverts the entire rendering model. Everything else here
  is emitted light on black; on paper the point cloud is re-read as *coverage*
  — luminance inverted into alpha — so highlights stay near-bare paper and
  shadows go heavy, the way a pencil works. 5 inks × 6 paper stocks.
- **Ring styles**: Classic, Vault (counter-rotating shutter segments reading
  as a tunnel), Orbital (inclined gyroscope hoops), Sonar (marching range
  rings and a swept beam with a decaying wake). The ring has its own centre,
  independent of the subject.
- **Orbital instrument**: the small rotating panel can carry any subject, not
  just the globe.
- **Subject in front** draws the whole instrument layer first, so nothing
  shows through the gaps between the subject's dots.

## Model pipeline

```bash
node glb2holo.js model.glb 40000 LABEL 23 --crop=0,0.15 --yaw=90
```

Area-weighted surface sampling with barycentric normal interpolation, plus a
grid-based ambient-occlusion approximation — cavities accumulate occlusion,
exposed surfaces don't. That AO is what carries most of the perceived detail.

`--crop` keeps a slab of the model measured down from the top, which is what
makes a face workable on a full-body figure: uncropped, a standing figure's
head is too small a fraction of the frame for any landmark to resolve.

For a cloud with no source mesh, `densify.js` interpolates new points between
existing neighbours, rejecting pairs whose normals disagree. It raises density
but cannot invent detail the original bake didn't capture.

Facial landmarks (mouth line, chin, eye anchors, jaw pivot) are measured per
model from the geometry itself — the nose is the frontmost centreline point,
the chin is the steep drop below it, the eye line is where the orbit recess
bottoms out.

## Third-party models

The baked clouds are derived from downloaded `.glb` assets. Check the original
licences before redistributing — at least one is a fan model of a copyrighted
character, which is fine for personal desktop use but not for redistribution.
