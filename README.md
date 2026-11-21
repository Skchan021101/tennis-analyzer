# Stroke Match

A browser app for tennis coaches. Film a student with a phone, tablet or laptop camera, and
compare each stroke with a pro reference, frame by frame. It covers forehands, both backhands,
slice, serve, both volleys and overheads.

Everything runs on the device. Video is never uploaded. The pose model runs in the browser
with TensorFlow.js.

## What it does

- **Automatic shot recognition.** Each swing is labelled as a forehand, two- or one-handed
  backhand, slice, serve, forehand or backhand volley, or overhead, using body cues only. Examples:
  hands together through contact means a two-handed backhand; the free hand still on the throat at
  the end of the take-back means a backhand; the hand above the head at contact means a serve or
  overhead. The comparison then uses the reference for that shot. Picking a shot yourself overrides
  the detection, and also corrects a misread stroke.
- **Live camera.** Point the camera at the student and start hitting. Each swing is detected
  automatically and scored a moment later. The last 8 strokes of the session stay one tap away.
- **Clips.** Upload a video, or record one with the phone's camera app. All strokes in the clip are
  found and you pick the one to review. Slow-motion clips (2×, 4×, 8×) are supported. Mark the
  speed so timing and hand-speed numbers are correct.
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
    swing time, hand speed, and the tossing arm on serves.
- **Without a reference,** the same checkpoints are checked against rough guide ranges for each
  shot.
- **History.** Save analyses per student to track progress. Export and import the library and
  history as a JSON file to move them to another device or share them with another coach.

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
| `js/capture.js` | Steps through clips frame by frame. The live camera loop keeps a 4-second buffer and detects each stroke when the hand-speed peak passes. |
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
- **Shot recognition is rule-based**, tuned on generated strokes, not on real footage. It needs the
  whole body in view. Forehand/backhand topspin vs slice is the least reliable call. If it guesses
  wrong, pick the shot by hand.
- **Checkpoints need visible joints.** A checkpoint is skipped when the joints it measures weren't
  clearly seen, for example knees out of frame.
- **The racquet isn't tracked.** Contact is estimated from the hand-speed peak, and you can
  correct it by hand.
- **Rough targets.** Guide ranges are rough coaching targets, not research norms. A reference clip
  is the real benchmark.
- **Device speed.** Older phones may track at 10–15 fps live. Recording a slow-motion clip and
  uploading it gives more accurate results.

See `NOTICE.md` for third-party licenses.
