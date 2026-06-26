'use client';
import { useReducer } from 'react';
import type { LivenessState, LivenessAction, LivenessStep } from '@/lib/types';

const INITIAL_STATE: LivenessState = {
  step:             'idle',
  confidence:       0,
  facePosition:     null,
  lighting:         null,
  challenges:       [],
  pendingChallenges:[],
  capturedBlob:     null,
  capturedDataURL:  null,
  errorMessage:     null,
  sessionStartTime: null,
  attemptCount:     0,
  isSimulationMode: false,
};

// Confidence locked in at each milestone — never decrements.
// 0–25 : face detection phase (builds gradually)
// 50   : blink done
// 75   : smile done
// 100  : mouth open done → capture
const CHALLENGE_CONFIDENCE: Record<string, number> = {
  blink:      50,
  smile:      75,
  mouth_open: 100,
};

function reducer(state: LivenessState, action: LivenessAction): LivenessState {
  switch (action.type) {

    case 'START_CAMERA':
      return { ...state, step: 'requesting_permission', errorMessage: null };

    case 'CAMERA_READY':
      return {
        ...state,
        step:              'detecting_face',
        sessionStartTime:  Date.now(),
        pendingChallenges: ['blink', 'smile', 'mouth_open'],
        confidence:        0,
        challenges:        [],
      };

    case 'PERMISSION_DENIED':
      return { ...state, step: 'permission_denied' };

    case 'NO_CAMERA':
      return { ...state, step: 'no_camera' };

    case 'FACE_DETECTED': {
      if (state.step.startsWith('challenge_') ||
          ['capturing','preview','uploading','verified','failed','timeout'].includes(state.step)) {
        return state;
      }
      return { ...state, step: 'detecting_face', facePosition: action.payload };
    }

    case 'FACE_LOST': {
      const ignore: LivenessStep[] = [
        'challenge_blink', 'challenge_smile', 'challenge_mouth_open',
        'capturing', 'preview', 'uploading', 'verified',
      ];
      if (ignore.includes(state.step)) return state;
      return { ...state, step: 'detecting_face' };
    }

    case 'FACE_TOO_FAR':
      return { ...state, step: 'face_too_far' };

    case 'FACE_TOO_CLOSE':
      return { ...state, step: 'face_too_close' };

    case 'FACE_NOT_CENTERED':
      return { ...state, step: 'face_not_centered' };

    case 'MULTIPLE_FACES':
      return { ...state, step: 'multiple_faces' };

    case 'LIGHTING_BAD': {
      const lightStep: LivenessStep = action.payload.isDark ? 'lighting_too_dark' : 'lighting_too_bright';
      return { ...state, step: lightStep, lighting: action.payload };
    }

    case 'LIGHTING_OK': {
      const isLightingStep = (state.step === 'lighting_too_dark' || state.step === 'lighting_too_bright');
      return {
        ...state,
        step:    isLightingStep ? 'detecting_face' : state.step,
        lighting: state.lighting ? { ...state.lighting, isAcceptable: true } : null,
      };
    }

    case 'UPDATE_CONFIDENCE': {
      // Only update during face detection — challenges set confidence via CHALLENGE_PASSED.
      // Cap at 25 so the challenge milestones (50/75/100) always feel like a reward.
      if (state.step !== 'detecting_face') return state;
      return { ...state, confidence: Math.min(action.payload, 25) };
    }

    case 'BEGIN_CHALLENGE':
      return { ...state, step: `challenge_${action.payload}` as LivenessStep };

    case 'CHALLENGE_PASSED': {
      const updatedChallenges = [...state.challenges, action.payload];
      const newConfidence     = CHALLENGE_CONFIDENCE[action.payload.type] ?? state.confidence;
      const nextChallenge     = state.pendingChallenges.find(
        c => !updatedChallenges.some(done => done.type === c),
      );
      if (nextChallenge) {
        return {
          ...state,
          challenges:  updatedChallenges,
          confidence:  newConfidence,
          step:        `challenge_${nextChallenge}` as LivenessStep,
        };
      }
      return { ...state, challenges: updatedChallenges, confidence: newConfidence, step: 'capturing' };
    }

    case 'CHALLENGE_FAILED':
      // Only used for hard errors (e.g. camera lost mid-challenge), not timeouts.
      return { ...state, step: 'failed', errorMessage: action.payload };

    case 'CAPTURE':
      return { ...state, step: 'capturing' };

    case 'CAPTURE_DONE':
      return { ...state, step: 'preview', capturedBlob: action.payload.blob, capturedDataURL: action.payload.dataURL };

    case 'UPLOAD_START':
      return { ...state, step: 'uploading' };

    case 'VERIFIED':
      return { ...state, step: 'verified', confidence: action.payload, errorMessage: null };

    case 'FAILED':
      return { ...state, step: 'failed', errorMessage: action.payload };

    case 'TIMEOUT':
      return { ...state, step: 'timeout', errorMessage: 'Session timed out. Please try again.' };

    case 'RETRY':
      return { ...INITIAL_STATE, attemptCount: state.attemptCount, isSimulationMode: state.isSimulationMode };

    case 'SET_SIMULATION_MODE':
      return { ...state, isSimulationMode: true };

    default:
      return state;
  }
}

export function useLivenessStateMachine() {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  return { state, dispatch };
}
