// Shot definitions, checkpoint metrics and coaching copy.
//
// Heights and distances are measured in torso lengths (shoulder-centre to
// hip-centre), so they don't depend on how far the camera is from the player.
// Guide ranges are rough coaching targets used only when no pro reference
// clip is selected; a reference clip filmed from the same angle is always
// the better benchmark.

export const METRICS = {
  loadKnee: {
    label: 'Knee bend while loading',
    short: 'Knee bend',
    unit: '°', digits: 0, tol: 10,
    help: 'Smallest knee angle before contact. 180° is a straight leg; lower means more bend.',
    hi: 'Legs stay straighter than {ref} while loading ({s} vs {t}). Sit lower into the shot so the legs can drive it.',
    lo: 'Bending deeper than {ref} ({s} vs {t}). Fine if balanced; check it isn\'t slowing the recovery.',
  },
  contactElbow: {
    label: 'Hitting elbow at contact',
    short: 'Elbow at contact',
    unit: '°', digits: 0, tol: 12,
    help: 'Angle at the hitting elbow at contact. 180° is a fully straight arm.',
    hi: 'The hitting arm is straighter at contact than {ref} ({s} vs {t}).',
    lo: 'The hitting arm is more bent at contact than {ref} ({s} vs {t}). Meet the ball a little further from the body and let the arm extend.',
    byShot: {
      serve: { lo: 'The arm is still bent at contact ({s} vs {t} for {ref}). Reach up and strike at full extension.' },
      overhead: { lo: 'The arm is still bent at contact ({s} vs {t} for {ref}). Get under the ball and hit at full reach.' },
      backhand1: { lo: 'The hitting arm is bent at contact ({s} vs {t} for {ref}). A one-hander wants a straight arm through the ball.' },
    },
  },
  contactHeight: {
    label: 'Contact height',
    short: 'Contact height',
    unit: 'T', digits: 2, tol: 0.2,
    help: 'Hand height at contact in torso lengths above the hips (0 = hips, 1 = shoulders).',
    hi: 'Contact is higher than {ref} ({s} vs {t}).',
    lo: 'Contact is lower than {ref} ({s} vs {t}). Adjust height with the legs rather than dropping the racquet.',
    byShot: {
      serve: { lo: 'Contact is lower than {ref} ({s} vs {t}). Toss a little higher and hit up at full reach.' },
      overhead: { lo: 'Contact is lower than {ref} ({s} vs {t}). Move back sooner and strike the ball at full reach.' },
    },
  },
  contactFront: {
    label: 'Contact in front of the hips',
    short: 'Contact in front',
    unit: 'T', digits: 2, tol: 0.25,
    help: 'How far ahead of the hips the hand is at contact, in torso lengths, in the direction of the swing. Most reliable from a side-on camera.',
    hi: 'Contact is further in front than {ref} ({s} vs {t}). Make sure the player isn\'t reaching for the ball.',
    lo: 'Contact is later and closer to the body than {ref} ({s} vs {t}). Prepare earlier and meet the ball further in front.',
  },
  finishHeight: {
    label: 'Finish height',
    short: 'Finish height',
    unit: 'T', digits: 2, tol: 0.3,
    help: 'Hand height where the follow-through ends, in torso lengths above the hips.',
    hi: 'The follow-through finishes higher than {ref} ({s} vs {t}).',
    lo: 'The follow-through finishes lower than {ref} ({s} vs {t}). Swing through and up to a complete finish.',
    byShot: {
      slice: { hi: 'The finish rises higher than {ref} ({s} vs {t}). On a slice, extend forward along the line of the ball.' },
      fhVolley: { hi: 'The volley finishes higher than {ref} ({s} vs {t}). Keep the punch short and firm.' },
      bhVolley: { hi: 'The volley finishes higher than {ref} ({s} vs {t}). Keep the punch short and firm.' },
    },
  },
  takeback: {
    label: 'Take-back depth',
    short: 'Take-back',
    unit: 'T', digits: 2, tol: 0.25,
    help: 'Furthest the hand travels behind the hips during preparation, in torso lengths.',
    hi: 'The take-back is bigger than {ref} ({s} vs {t}). Shorten it so the swing starts on time.',
    lo: 'The take-back is shorter than {ref} ({s} vs {t}). Complete the unit turn and racquet preparation.',
    byShot: {
      fhVolley: { hi: 'The take-back is bigger than {ref} ({s} vs {t}). On the volley keep the racquet in front and block or punch.' },
      bhVolley: { hi: 'The take-back is bigger than {ref} ({s} vs {t}). On the volley keep the racquet in front and block or punch.' },
    },
  },
  shoulderTurn: {
    label: 'Shoulder rotation',
    short: 'Shoulder rotation',
    unit: '%', digits: 0, tol: 12,
    help: 'How much the shoulder line rotates during the stroke, from the change in its apparent width. Only meaningful against a reference filmed from the same angle.',
    hi: 'The shoulders rotate more than {ref} ({s} vs {t}).',
    lo: 'The shoulders rotate less than {ref} ({s} vs {t}). Turn the shoulders fully in the preparation and uncoil through contact.',
  },
  trunkTilt: {
    label: 'Trunk lean at contact',
    short: 'Trunk lean',
    unit: '°', digits: 0, tol: 8,
    help: 'Lean of the trunk at contact. Positive leans in the direction of the swing.',
    hi: 'Leaning further into the shot than {ref} at contact ({s} vs {t}).',
    lo: 'More upright or leaning back at contact than {ref} ({s} vs {t}). Move the weight forward through the ball.',
  },
  stance: {
    label: 'Stance width at contact',
    short: 'Stance width',
    unit: 'T', digits: 2, tol: 0.3,
    help: 'Distance between the ankles at contact, in torso lengths.',
    hi: 'The base is wider than {ref} ({s} vs {t}).',
    lo: 'The base is narrower than {ref} ({s} vs {t}). Widen the stance for balance and leg drive.',
  },
  swingTime: {
    label: 'Forward swing time',
    short: 'Swing time',
    unit: 's', digits: 2, tol: 0.06,
    help: 'Time from the end of the preparation (or trophy position) to contact.',
    hi: 'The forward swing takes longer than {ref} ({s} vs {t}). Accelerate more decisively into contact.',
    lo: 'The forward swing is quicker than {ref} ({s} vs {t}).',
  },
  wristSpeed: {
    label: 'Peak hand speed',
    short: 'Hand speed',
    unit: 'T/s', digits: 1, tolRel: 0.15,
    help: 'Fastest the hitting hand moves, in torso lengths per second. Needs real-time or correctly marked slow-motion video.',
    hi: 'Hand speed is higher than {ref} ({s} vs {t}).',
    lo: 'Hand speed is lower than {ref} ({s} vs {t}). Generate more racquet speed from the legs and trunk rotation.',
  },
  tossArm: {
    label: 'Tossing arm at the trophy',
    short: 'Tossing arm',
    unit: 'T', digits: 2, tol: 0.3,
    help: 'Height of the non-hitting hand at the trophy position, in torso lengths above the hips.',
    hi: 'The tossing arm is higher than {ref} at the trophy ({s} vs {t}).',
    lo: 'The tossing arm drops early ({s} vs {t} for {ref}). Keep it up longer to hold the shoulder tilt.',
    byShot: {
      overhead: {
        lo: 'The pointing arm drops early ({s} vs {t} for {ref}). Point at the ball until the swing starts.',
        hi: 'The pointing arm is higher than {ref} ({s} vs {t}).',
      },
    },
  },
};

// pre/post: seconds of video kept before and after contact.
// minSpeed: minimum hand speed (torso lengths/s) to count as a stroke.
// prep: how the end of the preparation is found ('takeback' = hand furthest
// back, 'trophy' = deepest knee bend before the swing).
export const SHOTS = [
  {
    id: 'forehand', short: 'Forehand', name: 'Forehand', pre: 1.1, post: 0.7, minSpeed: 4, prep: 'takeback',
    phases: ['Unit turn', 'Contact', 'Finish'],
    metrics: {
      loadKnee: [115, 155], contactElbow: [100, 175], contactHeight: [0.3, 1.2],
      contactFront: [0.3, 1.6], finishHeight: [1.0, 2.3], takeback: null,
      shoulderTurn: null, trunkTilt: null, stance: [1.0, 2.4], swingTime: null, wristSpeed: null,
    },
    film: 'Side-on, level with the hitting hip, 4–6 m away, whole body in frame.',
  },
  {
    id: 'backhand2', short: '2H backhand', name: 'Backhand (two-handed)', pre: 1.1, post: 0.7, minSpeed: 4, prep: 'takeback',
    phases: ['Unit turn', 'Contact', 'Finish'],
    metrics: {
      loadKnee: [115, 155], contactElbow: [110, 175], contactHeight: [0.3, 1.2],
      contactFront: [0.2, 1.4], finishHeight: [1.0, 2.3], takeback: null,
      shoulderTurn: null, trunkTilt: null, stance: [1.0, 2.4], swingTime: null, wristSpeed: null,
    },
    film: 'Side-on, level with the front hip, 4–6 m away, whole body in frame.',
  },
  {
    id: 'backhand1', short: '1H backhand', name: 'Backhand (one-handed)', pre: 1.1, post: 0.7, minSpeed: 4, prep: 'takeback',
    phases: ['Unit turn', 'Contact', 'Finish'],
    metrics: {
      loadKnee: [115, 155], contactElbow: [150, 180], contactHeight: [0.3, 1.2],
      contactFront: [0.4, 1.7], finishHeight: [1.0, 2.3], takeback: null,
      shoulderTurn: null, trunkTilt: null, stance: [1.0, 2.4], swingTime: null, wristSpeed: null,
    },
    film: 'Side-on, level with the front hip, 4–6 m away, whole body in frame.',
  },
  {
    id: 'slice', short: 'Slice', name: 'Slice backhand', pre: 1.1, post: 0.7, minSpeed: 3, prep: 'takeback',
    phases: ['Preparation', 'Contact', 'Extension'],
    metrics: {
      loadKnee: [120, 160], contactElbow: [140, 180], contactHeight: [0.3, 1.2],
      contactFront: [0.3, 1.6], finishHeight: [0.4, 1.4], takeback: null,
      shoulderTurn: null, trunkTilt: null, stance: [1.0, 2.4], swingTime: null,
    },
    film: 'Side-on, level with the front hip, 4–6 m away, whole body in frame.',
  },
  {
    id: 'serve', short: 'Serve', name: 'Serve', pre: 1.8, post: 0.7, minSpeed: 4, prep: 'trophy',
    phases: ['Trophy', 'Contact', 'Follow-through'],
    metrics: {
      loadKnee: [100, 145], tossArm: [1.8, 3.0], contactElbow: [155, 180],
      contactHeight: [1.9, 2.9], trunkTilt: null, swingTime: null, wristSpeed: null, finishHeight: null,
    },
    film: 'Side-on from the hitting-arm side, or from behind the baseline. Leave room above the head for the toss.',
  },
  {
    id: 'fhVolley', short: 'FH volley', name: 'Forehand volley', pre: 0.6, post: 0.4, minSpeed: 2.5, prep: 'takeback',
    phases: ['Set', 'Contact', 'Punch'],
    metrics: {
      loadKnee: [120, 165], contactElbow: [100, 165], contactHeight: [0.2, 1.6],
      contactFront: [0.4, 1.7], takeback: [0, 0.5], finishHeight: null, stance: [1.0, 2.6],
    },
    film: 'Side-on at the net post, 3–5 m away, whole body in frame.',
  },
  {
    id: 'bhVolley', short: 'BH volley', name: 'Backhand volley', pre: 0.6, post: 0.4, minSpeed: 2.5, prep: 'takeback',
    phases: ['Set', 'Contact', 'Punch'],
    metrics: {
      loadKnee: [120, 165], contactElbow: [110, 175], contactHeight: [0.2, 1.6],
      contactFront: [0.4, 1.7], takeback: [0, 0.5], finishHeight: null, stance: [1.0, 2.6],
    },
    film: 'Side-on at the net post, 3–5 m away, whole body in frame.',
  },
  {
    id: 'overhead', short: 'Overhead', name: 'Overhead', pre: 1.3, post: 0.6, minSpeed: 4, prep: 'trophy',
    phases: ['Set', 'Contact', 'Follow-through'],
    metrics: {
      tossArm: [1.5, 3.0], loadKnee: [110, 160], contactElbow: [150, 180],
      contactHeight: [1.8, 2.9], trunkTilt: null, wristSpeed: null,
    },
    film: 'Side-on from the hitting-arm side with room above the head.',
  },
];

export const SHOT_BY_ID = Object.fromEntries(SHOTS.map((s) => [s.id, s]));

// Capture window used when the shot type is detected automatically: long
// enough for a serve, sensitive enough for a volley.
export const AUTO = { id: 'auto', name: 'Auto-detect', pre: 1.8, post: 0.7, minSpeed: 3, film: 'Side-on, level with the hips, 4–6 m away, whole body in frame (with room above the head for serves).' };
export const shotConfig = (id) => SHOT_BY_ID[id] || AUTO;

export const VIEWS = [
  { id: 'side', name: 'Side-on' },
  { id: 'behind', name: 'Behind' },
  { id: 'front', name: 'Front' },
];

export function formatMetric(key, value) {
  if (value == null || !Number.isFinite(value)) return '–';
  const m = METRICS[key];
  const v = value.toFixed(m.digits);
  if (m.unit === '°') return `${v}°`;
  if (m.unit === '%') return `${v}%`;
  if (m.unit === 's') return `${v} s`;
  return `${v} ${m.unit}`;
}

export function metricCopy(key, shotId, dir) {
  const m = METRICS[key];
  return (m.byShot && m.byShot[shotId] && m.byShot[shotId][dir]) || m[dir];
}
