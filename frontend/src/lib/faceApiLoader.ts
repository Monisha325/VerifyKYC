// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FaceApiModule = any;

export interface FaceApiLoadResult {
  success: boolean;
  faceapi: FaceApiModule | null;
  error?: string;
}

let cachedFaceApi: FaceApiModule | null = null;
let loadPromise: Promise<FaceApiLoadResult> | null = null;

export async function loadFaceApi(): Promise<FaceApiLoadResult> {
  if (cachedFaceApi) return { success: true, faceapi: cachedFaceApi };
  if (loadPromise) return loadPromise;

  loadPromise = (async (): Promise<FaceApiLoadResult> => {
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('face-api load timeout')), 30000),
      );

      const load = (async () => {
        console.log('[VeriKYC] Loading face-api models from /models/...');
        const faceapi = await import('@vladmandic/face-api');
        await Promise.all([
          faceapi.nets.ssdMobilenetv1.loadFromUri('/models'),
          faceapi.nets.faceLandmark68Net.loadFromUri('/models'),
          faceapi.nets.faceExpressionNet.loadFromUri('/models'),
        ]);
        return faceapi;
      })();

      const faceapi = await Promise.race([load, timeout]);
      cachedFaceApi = faceapi;
      console.log('[VeriKYC] face-api models loaded successfully');
      return { success: true, faceapi };
    } catch (err) {
      loadPromise = null;
      return {
        success: false,
        faceapi: null,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  })();

  return loadPromise;
}

export function getFaceApi(): FaceApiModule | null {
  return cachedFaceApi;
}
