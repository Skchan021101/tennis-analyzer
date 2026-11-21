# Stroke Match

A browser app for tennis coaches. Film a student with a phone, tablet or laptop camera, and
compare each stroke with a pro reference, frame by frame. It covers forehands, both backhands,
slice, serve, both volleys and overheads.

Everything runs on the device. Video is never uploaded. The pose model runs in the browser
with TensorFlow.js.

## What it does

- **Automatic shot recognition.** Each swing is labelled as a forehand, two- or one-handed
  backhand, slice, serve, forehand or backhand volley, or overhead by a small model trained on real
  strokes, one per camera angle (see "Shot recognition" below). The comparison then uses the
  references for that shot. When the model isn't sure, the result says so and offers its two best
  guesses as one-tap fixes. Picking a shot yourself always overrides it.
- **Live camera.** Point the camera at the student and start hitting. Each swing is detected
  automatically and confirmed about 1.6 s later, once it's clear the movement was the hit and not
  the preparation. A label pops up over the video (shot, score, main thing to work on), the hand's
  path is drawn live, the last stroke loops in slow motion in a corner, and a running count of
  strokes by type sits on the video. The last 8 strokes stay one tap away; any of them can be
  discarded. A **Swing detection** setting (Strict / Normal / Sensitive) tunes how readily movements
  count as strokes.
- **Clips.** Upload a video, or record one with the phone's camera app. All strokes in the clip are
  found and you pick the one to review. Slow-motion clips (2×, 4×, 8×) are supported. Mark the
  speed so timing and hand-speed numbers are correct.
- **Starter references.** One tap adds 94 skilled-player strokes (skeletons only) for every shot
  except slice, side-on, from behind and from the front, built from two openly licensed research
  datasets (see "Data" below).
- **Pro library.** Add reference strokes from pro footage you have the right to use, or your own
  demonstrations. "Save as pro reference" turns any analyzed stroke into a reference.
- **Bulk import.** Choose a whole folder (desktop) or several clips at once (phones too). Each clip
  gives one reference, its strongest stroke. With Auto-detect, folder or file names such as
  `forehand`, `backhand2hands`, `backhand_slice`, `volley`, `serve` or `smash` set the shot;
  otherwise it's detected from the swing.
- **Closest match.** When a shot has several references, each stroke is compared with all of them
  (same camera angle where possible) and scored against the most similar one.
- **Comparison.**
  - The two strokes are lined up phase by phase (preparation or trophy, contact, finish), so a
    slower student swing still matches the pro's at each phase.
  - You get a 0–100 match score with a score for each phase.
  - Side-by-side video with skeletons, or both skeletons overlaid.
  - Up to three coaching points, plus a checkpoint table: knee bend, elbow at contact, contact
    height, contact in front, finish height, take-back, shoulder rotation, trunk lean, stance,
    swing time, hand speed, and the tossing arm on serves. With a front or behind camera, the
    angle-dependent ones (elbow and knee angles, contact in front, trunk lean, take-back) are left
    out because a single camera can't measure them from there.
- **Without a reference,** the same checkpoints are checked against rough guide ranges for each
  shot.
- **History.** Save analyses per student to track progress. Export and import the library and
  history as a JSON file to move them to another device or share them with another coach.

## Shot recognition

The shot type is recognised by three small networks in `js/shotmodel.js`, one per camera angle,
trained on real strokes (`tools/training` rebuilds them). Measured on players left out of
training (6-fold, players never mixed between training and testing):

| Camera angle | Strokes | Right overall | Right when confident (≥ 70%) | Weakest shots |
| --- | --- | --- | --- | --- |
| Side-on | 971 from 24 players | 83.5% | 87% (90% of strokes) | one-handed backhand 48%, serve 70% |
| Behind | 967 from 24 players | 83.1% | 87% (89% of strokes) | one-handed backhand 52%, serve 74% |
| Front | 1,989 from 60 players | 66.1% | 73% (76% of strokes) | slice 38%, one-handed backhand 38%, serve 57% |

The hand-written rules used before got 39–46% right on the same strokes.

End to end on THETIS beginners p10–p20, who were kept out of training entirely (front camera, no
ball, 17 fps): a stroke was found in 79% of clips, the shot was right 55% of the time, and 68% when
the model was confident. **Front-view footage of beginners is the weakest case**, partly because a
server standing sideways to a front camera hides one arm behind the other. Film side-on when you
can.

What the numbers don't cover: none of the test footage is your own (your camera, your court, a real
ball). Slice has no side-on or behind training data at all, and one-handed backhands come from only
a few players. When a stroke is misread, the one-tap fix or the shot chips correct it.

## Data

| Source | What's used | Licence |
| --- | --- | --- |
| [Tennis-MoCap](https://github.com/jdpulgarin/Tennis-MoCap) | 3D motion capture of 17 players (5 high-performance), 6 strokes, cut into single strokes and rendered side-on, from behind and from the front | CC BY-SA 3.0 |
| [MvST](https://github.com/iasror/DatasetMvST) | Forehands and backhands of 8 players, side-on and from behind | MIT |
| [THETIS](https://github.com/THETIS-dataset/dataset) | Front-view videos of 55 players and 12 strokes, tracked with the app's pose model | No licence file; cite the authors |

The starter references use only Tennis-MoCap (high-performance players) and MvST (trained
players). THETIS references can be built with `tools/training` and imported by hand. Because they
derive from Tennis-MoCap, `js/shotmodel.js` and `library/starter.json` are CC BY-SA 3.0. See
`NOTICE.md`.

## Reference clips from the THETIS dataset

[THETIS](https://github.com/THETIS-dataset/dataset) is a public research dataset: 55 players (p32–p55
are the experienced ones) performing 12 strokes, filmed from the front, without a ball. Its videos
are AVI files that browsers can't play, so convert them first with the included script. It needs
`git` and `ffmpeg`; on Windows, use Git Bash.

```bash
tools/get-thetis.sh thetis-mp4 32-55 1
```

That downloads take 1 of every experienced player (about 260 clips, roughly 90 MB as MP4) into
`thetis-mp4/<shot>/`. Then in the app: **Pro library**, set Shot to **Auto-detect**, Camera angle to
**Front**, and choose **Import a folder** → `thetis-mp4`. Film students from the front too, so they
match. Forehand slice is skipped because the app doesn't analyze it. Please cite the THETIS authors,
and check with them before any commercial use.

## Filming tips

- Keep the whole body in frame, with space above the head for serves and overheads.
- Film the student from the **same angle as the reference**. Side-on, level with the hips,
  4–6 m away, works best for groundstrokes and volleys.
- Use a tripod or a fence clip. A moving camera hurts the measurements.
- Use good light and a high frame rate. 60 fps live, or slow-motion clips, give the cleanest
  contact frames.
- If the detected contact frame is off, nudge it with the ◀ ▶ buttons under the viewer.

## Running it

The live camera needs **https** (or `localhost`).

### GitHub Pages (recommended)

1. In the repository, go to **Settings → Pages**. Under **Build and deployment → Source**,
   choose **GitHub Actions**.
2. Merge to `main`. The workflow in `.github/workflows/pages.yml` runs the tests and publishes
   the site to `https://<user>.github.io/<repo>/`.
3. Open that link on the phone or tablet. Use "Add to Home Screen" to get an app icon. After the
   first visit it also works offline, which helps on courts with poor signal.

### Locally

```bash
npm start
```

Then open http://localhost:8080. Any static file server works; there is no build step.

### Tests

```bash
npm test
```

The tests run the analysis code (stroke detection, events, metrics, alignment and scoring) on
generated strokes. They need Node 22 or later.

## How it works

| File | Role |
| --- | --- |
| `js/pose.js` | MoveNet in TensorFlow.js. Thunder (accurate) is used for clips and Lightning (fast) for the live camera. A crop region follows the player, so a small figure in a wide shot still gets enough pixels. |
| `js/capture.js` | Steps through clips frame by frame. The live camera loop keeps a 5.5-second buffer and confirms each stroke 1.6 s after its hand-speed peak, so a hit that follows the preparation replaces it. |
| `js/shotmodel.js` | The trained shot recognisers (one per camera angle) and their measured accuracy. |
| `library/starter.json` | The built-in starter references. |
| `js/analysis.js` | Cleans the tracks: fixes left/right swaps, fills gaps, smooths and resamples. Also finds strokes, events and metrics, and handles alignment and scoring. Pure functions, unit-tested in Node. |
| `js/shots.js` | Shot definitions, checkpoint metrics, guide ranges and coaching copy. Edit this file to tune targets or wording. |
| `js/viewer.js` | Synced side-by-side and overlay playback. |
| `js/store.js` | IndexedDB storage for references and history, in this browser only. |

The measurements are 2D, taken from one camera:

- Distances are in torso lengths (shoulders to hips), so camera distance doesn't matter.
- Swings toward the left are mirrored, so footage filmed from either side compares fairly.
- Left-handers are compared hitting arm to hitting arm.
- Angle-dependent numbers (contact in front, shoulder rotation, trunk lean) only mean something
  against a reference filmed from the same angle.

## Limitations

- **One player in frame.** The model tracks the most prominent person, so keep other players out
  of the shot.
- **Shot recognition is roughly 83% right side-on or from behind, 66% from the front**, on players
  it wasn't trained on (see above). It needs the whole body in view. Slice and one-handed
  backhand are the least reliable calls. If it guesses wrong, pick the shot by hand.
- **A preparation movement can still count as a stroke** when it is much faster than the hit
  (for example a shadow swing without a ball). Discard it, or set Swing detection to Strict.
- **Checkpoints need visible joints.** A checkpoint is skipped when the joints it measures weren't
  clearly seen, for example knees out of frame.
- **The racquet isn't tracked.** Contact is estimated from the hand-speed peak, and you can
  correct it by hand.
- **Rough targets.** Guide ranges are rough coaching targets, not research norms. A reference clip
  is the real benchmark.
- **Device speed.** Older phones may track at 10–15 fps live. Recording a slow-motion clip and
  uploading it gives more accurate results.

See `NOTICE.md` for third-party licenses.
