# Training the shot recognisers and building the starter references

These scripts rebuild `js/shotmodel.js` (one shot recogniser per camera angle) and
`library/starter.json` (the built-in reference strokes) from open tennis datasets. They run in
Node 22 with ffmpeg and git available. Pose tracking uses the same MoveNet Thunder model and
tracking crop as the app, through TensorFlow.js's WASM backend.

## 1. Install and fetch the data

```bash
cd tools/training
npm install
mkdir -p data
git clone --depth 1 https://github.com/jdpulgarin/Tennis-MoCap data/Tennis-MoCap
git clone --depth 1 --filter=blob:none --sparse https://github.com/iasror/DatasetMvST data/DatasetMvST
git -C data/DatasetMvST sparse-checkout set Dataset_AQA_CSV
git clone --filter=blob:none --no-checkout --depth 1 https://github.com/THETIS-dataset/dataset data/thetis
```

## 2. Turn each source into single strokes

```bash
node mocap.mjs        # Tennis-MoCap BVH -> mocap.jsonl (each stroke rendered side-on, behind, front)
node mvst.mjs         # MvST MediaPipe CSVs -> mvst.jsonl (side and behind)
# THETIS experienced players p32-p55: track the RGB videos with MoveNet (about 15 s per clip).
git -C data/thetis ls-tree -r --name-only HEAD VIDEO_RGB/ | grep -v forehand_slice | grep -E '/p(3[2-9]|4[0-9]|5[0-5])_' > experts.txt
split -n r/4 -d experts.txt part_
for i in 0 1 2 3; do THETIS_REPO=data/thetis FPS=17 node extract.mjs out_$i.jsonl @part_0$i & done; wait
```

## 3. Features, evaluation, models, references

```bash
node rows.mjs                              # detect each stroke once, cache features (rows.json)
node perview.mjs                           # accuracy on players left out of training, per camera angle
node final.mjs ../../js/shotmodel.js       # train the three models, print confidence calibration
node lefty.mjs                             # left-handed check: same answer as the mirrored right-hander
node library.mjs lib 5 && cp lib/starter.json ../../library/starter.json
```

`library.mjs` also writes `lib/thetis-front.json`: THETIS references for the front camera angle
(including one-handed backhand and slice). THETIS has no licence file and asks users to cite it, so
that file isn't published with the app. Import it yourself with **Pro library → Import**.

## Notes

- One- or two-handed backhand labels for Tennis-MoCap and MvST players are set per player from the
  gap between the hands at contact (`BACKHAND_STYLE` in `features.mjs`). Players whose gap is
  ambiguous are left out.
- MvST coordinates are normalised to the image. A 16:9 frame is assumed, because per-file
  limb-length fits cluster around that ratio.
- Licences: Tennis-MoCap is CC BY-SA 3.0, so the models and references derived from it are
  CC BY-SA 3.0 too. MvST is MIT. THETIS asks for a citation (Gourgari et al., CVPR Workshops 2013).
