# Third-party components

- **MoveNet** single-pose Lightning and Thunder models (`models/`), © Google LLC,
  Apache License 2.0. Source: https://tfhub.dev/google/movenet/singlepose/thunder/4
  and https://tfhub.dev/google/movenet/singlepose/lightning/4. The TensorFlow.js graph-model
  files are the conversions published in the `@vladmandic/human-models` npm package
  (MIT, see `models/LICENSE-vladmandic-conversion.txt`).
- **TensorFlow.js** 4.22.0 (`vendor/tf-4.22.0.min.js`), © Google LLC, Apache License 2.0.

## Data used for shot recognition and the reference libraries

- **Tennis-MoCap** (https://github.com/jdpulgarin/Tennis-MoCap): 3D motion capture of 17
  players, 6 strokes. Pulgarin-Giraldo J.D. et al., "A Similarity Indicator for Differentiating
  Kinematic Performance Between Qualified Tennis Players", LNCS 10125, 2017. Licensed
  **CC BY-SA 3.0**. `js/shotmodel.js` and the reference libraries built from it are derived
  works and are shared under CC BY-SA 3.0 as well.
- **MvST** (https://github.com/iasror/DatasetMvST): MediaPipe skeletons of forehands and
  backhands filmed side-on and from behind. Asror I., Abdurohman M., Erfianto B., Rizal A.
  **MIT licence**.
- **THETIS** (https://github.com/THETIS-dataset/dataset): Gourgari S., Goudelis G.,
  Karpouzis K., Kollias S., "THETIS: Three dimensional tennis shots, a human action dataset",
  CVPR Workshops 2013. The repository has no licence file and asks users to cite the paper;
  treat it as a research dataset and ask the authors before commercial use.
