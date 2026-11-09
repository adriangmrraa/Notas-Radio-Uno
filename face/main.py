"""
face — servicio de rostros InsightFace (T-23, D4)

Servicio Python FastAPI stateless que corre como container separado
(EasyPanel `face`, puerto interno 8000). Expone:

  GET  /health  → {status, model, loaded}
  POST /enroll  → {faceCount, embedding?}   (foto → embedding512, solo si 1 cara)
  POST /detect  → {faces: [{bbox, embedding}]}  (frame → todas las caras)

Modelo: insightface `buffalo_l` (SCRFD detect + ArcFace 512d) sobre
onnxruntime CPU. El matching NO se hace acá — Node lee los embeddings
persistidos en face_embeddings y calcula cosine en app (GATE-1 fallback).

Imagen de entrada (JSON):
  {"image": "<base64>"}  — acepta base64 pelado o data URL
  ("data:image/jpeg;base64,....").

Enrolled-only por diseño: este servicio nunca identifica — solo extrae
embeddings. La identificación (match por tenant + consent_at) vive en
faceService.ts del engine.
"""

import base64
import binascii
import io
import logging
import os
import threading
from typing import Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

# insightface necesita cv2 + onnxruntime; imports dentro de try para que
# /health pueda reportar "loaded": false si falta el modelo en vez de
# crashear el proceso al boot.
try:
    import cv2  # noqa: F401
    from insightface.app import FaceAnalysis
    _IMPORT_ERROR: Optional[Exception] = None
except Exception as exc:  # pragma: no cover - environment guard
    FaceAnalysis = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc

log = logging.getLogger("face")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))

MODEL_NAME = os.environ.get("FACE_MODEL", "buffalo_l")
MODEL_ROOT = os.environ.get("INSIGHTFACE_ROOT", os.path.expanduser("~/.insightface"))
DET_SIZE = int(os.environ.get("FACE_DET_SIZE", "640"))
EMBEDDING_DIM = 512

app = FastAPI(title="periodistapp-face", version="1.0.0")

# FaceAnalysis se carga lazy en el primer request (el download de modelos
# ocurre en build-time via Dockerfile; en runtime solo se carga a memoria).
_face_app = None
_face_lock = threading.Lock()


def get_face_app():
    """Carga perezosa del pipeline SCRFD+ArcFace. Thread-safe."""
    global _face_app
    if _face_app is not None:
        return _face_app
    with _face_lock:
        if _face_app is not None:
            return _face_app
        if FaceAnalysis is None:
            raise RuntimeError(f"insightface no disponible: {_IMPORT_ERROR}")
        log.info("Cargando modelo %s (root=%s, det_size=%s)...", MODEL_NAME, MODEL_ROOT, DET_SIZE)
        fa = FaceAnalysis(
            name=MODEL_NAME,
            root=MODEL_ROOT,
            providers=["CPUExecutionProvider"],
        )
        # ctx_id=0 → CPU cuando providers solo tiene CPUExecutionProvider
        fa.prepare(ctx_id=0, det_size=(DET_SIZE, DET_SIZE))
        _face_app = fa
        log.info("Modelo %s listo", MODEL_NAME)
        return _face_app


class ImageRequest(BaseModel):
    image: str = Field(..., description="Imagen en base64 o data URL")


def decode_image(b64: str) -> np.ndarray:
    """base64/data-URL → ndarray BGR (formato que espera insightface)."""
    if "," in b64 and b64.strip().startswith("data:"):
        b64 = b64.split(",", 1)[1]
    try:
        raw = base64.b64decode(b64, validate=False)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"imagen base64 inválida: {exc}")
    if not raw:
        raise HTTPException(status_code=400, detail="imagen vacía")
    buf = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=400, detail="no se pudo decodificar la imagen (formato no soportado)")
    return img


def normalize(v: np.ndarray) -> list[float]:
    """L2-normaliza y devuelve lista de floats (JSON-serializable)."""
    norm = float(np.linalg.norm(v))
    if norm <= 0:
        return [0.0] * EMBEDDING_DIM
    out = (v / norm).astype(np.float32)
    return [round(float(x), 6) for x in out.tolist()]


def bbox_xywh(face) -> list[int]:
    """insightface devuelve bbox como [x1,y1,x2,y2] → [x,y,w,h] ints."""
    x1, y1, x2, y2 = [float(v) for v in face.bbox.tolist()]
    return [int(round(x1)), int(round(y1)), int(round(x2 - x1)), int(round(y2 - y1))]


@app.get("/health")
def health():
    return {
        "status": "ok" if _face_app is not None else "warming",
        "model": MODEL_NAME,
        "loaded": _face_app is not None,
        "importError": str(_IMPORT_ERROR) if _IMPORT_ERROR else None,
    }


@app.post("/enroll")
def enroll(req: ImageRequest):
    """
    Foto de enrolamiento → {faceCount, embedding?}.
    Solo devuelve embedding cuando hay EXACTAMENTE 1 cara: la política de
    enrolamiento (0 caras = no_face, >1 = multi_face) la decide el caller.
    """
    img = decode_image(req.image)
    try:
        faces = get_face_app().get(img)
    except Exception as exc:
        log.exception("enroll falló en inferencia")
        raise HTTPException(status_code=503, detail=f"face backend error: {exc}")

    result = {"faceCount": len(faces)}
    if len(faces) == 1:
        emb = faces[0].normed_embedding if faces[0].normed_embedding is not None else faces[0].embedding
        result["embedding"] = normalize(np.asarray(emb, dtype=np.float32))
    return result


@app.post("/detect")
def detect(req: ImageRequest):
    """
    Frame del crudo → {faces: [{bbox: [x,y,w,h], embedding: float[512]}]}.
    Devuelve TODAS las caras detectadas (el matching por tenant se hace
    en Node con cosine sobre face_embeddings — GATE-1 fallback).
    """
    img = decode_image(req.image)
    try:
        faces = get_face_app().get(img)
    except Exception as exc:
        log.exception("detect falló en inferencia")
        raise HTTPException(status_code=503, detail=f"face backend error: {exc}")

    out = []
    for f in faces:
        emb = f.normed_embedding if f.normed_embedding is not None else f.embedding
        out.append({
            "bbox": bbox_xywh(f),
            "embedding": normalize(np.asarray(emb, dtype=np.float32)),
            "detScore": round(float(f.det_score), 4) if hasattr(f, "det_score") else None,
        })
    return {"faces": out}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
