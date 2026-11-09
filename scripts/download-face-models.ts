/**
 * download-face-models — descarga los modelos InsightFace buffalo_l
 * (SCRFD det_10g + ArcFace w600k_r50) a `.cache/face-models/` con verificación
 * SHA-256. Correr: `npx tsx scripts/download-face-models.ts`
 *
 * Es la acción sugerida por el 503 `FACE_DETECTOR_UNAVAILABLE` de la API.
 * No se usa en build ni en tests — es perezoso y manual.
 */
import {
    ensureFaceModels,
    faceModelPaths,
    faceModelsDir,
    faceModelsPresent,
    FACE_MODELS_URL,
    FACE_MODELS_SHA256,
} from '../src/server/services/faceModels';

async function main(): Promise<void> {
    console.log('Modelos destino:', faceModelsDir());
    console.log('URL:', process.env.FACE_MODELS_URL ?? FACE_MODELS_URL);
    console.log('SHA-256 esperado:', process.env.FACE_MODELS_SHA256 ?? FACE_MODELS_SHA256);

    if (faceModelsPresent()) {
        console.log('Los modelos ya están descargados.');
    } else {
        console.log('Descargando (una sola vez, ~280 MB)...');
    }

    const { detPath, recPath } = await ensureFaceModels();
    console.log('OK');
    console.log('  det:', detPath);
    console.log('  rec:', recPath);
    process.exit(0);
}

main().catch((e) => {
    console.error('Falló la descarga de modelos:', e instanceof Error ? e.message : e);
    process.exit(1);
});
