import logging
import secrets
from pathlib import Path

from fastapi import APIRouter, File, Header, HTTPException, UploadFile
from pydantic import BaseModel, Field

from app.core.config import get_settings
from app.rag.vectorstore import add_documents
from app.rag.workflow import ask
from app.services.audit import write_audit
from app.services.ingestion import SUPPORTED, chunk_documents, load_file

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api")
settings = get_settings()

MAX_UPLOAD_BYTES = 20 * 1024 * 1024  # 20 MB


class ChatRequest(BaseModel):
    question: str = Field(min_length=2, max_length=3000)


def require_admin(x_admin_key: str) -> None:
    """Reject the request unless a non-empty admin key is configured and matches."""
    if not settings.admin_api_key:
        raise HTTPException(status_code=503, detail="Document upload is disabled on this server.")
    # Compare as bytes so non-ASCII headers cannot raise, and in constant time.
    if not secrets.compare_digest(x_admin_key.encode(), settings.admin_api_key.encode()):
        raise HTTPException(status_code=401, detail="Invalid admin key")


@router.get("/health")
def health():
    return {"status": "ok", "service": settings.app_name}


@router.post("/chat")
def chat(payload: ChatRequest):
    try:
        result = ask(payload.question)
    except Exception:
        # Details go to the server log only; the client gets a generic message.
        logger.exception("chat failed")
        raise HTTPException(
            status_code=500,
            detail="The assistant hit an error. Please try again in a moment.",
        )

    try:
        write_audit(payload.question, result["source_used"], result.get("trace", []))
    except Exception:
        # A logging failure must never cost the user their answer.
        logger.exception("audit write failed")

    return {
        "answer": result["answer"],
        "source_used": result["source_used"],
        "trace": result.get("trace", []),
        "citations": result.get("citations", []),
        "rewritten_query": result.get("current_query", payload.question),
    }


# Plain `def` (not async): FastAPI runs it in a worker thread, so the slow
# parse/embed/upsert work does not block other requests.
@router.post("/ingest")
def ingest(file: UploadFile = File(...), x_admin_key: str = Header(default="")):
    require_admin(x_admin_key)

    filename = Path(file.filename or "").name
    suffix = Path(filename).suffix.lower()
    if not filename or suffix not in SUPPORTED:
        raise HTTPException(status_code=400, detail=f"Supported: {', '.join(sorted(SUPPORTED))}")

    upload_dir = Path(settings.upload_dir)
    upload_dir.mkdir(parents=True, exist_ok=True)
    dest = upload_dir / filename

    # Stream to disk in chunks and stop if the file is too large.
    written = 0
    try:
        with dest.open("wb") as out:
            while chunk := file.file.read(1024 * 1024):
                written += len(chunk)
                if written > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="File is larger than 20 MB.")
                out.write(chunk)
    except HTTPException:
        dest.unlink(missing_ok=True)
        raise

    try:
        docs = load_file(dest)
        chunks = chunk_documents(docs)
        if not chunks:
            raise HTTPException(status_code=422, detail="No readable text found in this file.")
        ids = add_documents(chunks)
    except HTTPException:
        raise
    except Exception:
        logger.exception("ingest failed for %s", filename)
        raise HTTPException(status_code=500, detail="Could not index this document.")

    return {"message": "Document indexed", "file": dest.name, "chunks": len(chunks), "ids_created": len(ids)}