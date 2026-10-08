import logging
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.api.routes import router
from app.core.config import get_settings, BASE_DIR
from app.core.logging import configure_logging
from app.services.audit import init_db

configure_logging()
settings = get_settings()
logger = logging.getLogger("app.http")

# Swagger UI loads assets from a CDN, so it is exempt from the strict CSP below.
DOC_PATHS = ("/docs", "/redoc", "/openapi.json")
CSP = (
    "default-src 'self'; "
    "style-src 'self' https://fonts.googleapis.com; "
    "font-src https://fonts.gstatic.com; "
    "script-src 'self'; img-src 'self' data:; "
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'"
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()  # runs at startup, not at import time (safer for tests)
    yield


app = FastAPI(title=settings.app_name, version="1.0.0", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1000)


@app.middleware("http")
async def request_context(request: Request, call_next):
    rid = uuid.uuid4().hex[:8]
    start = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        # Full details go to the log; the client only gets a request id.
        logger.exception("unhandled error rid=%s %s %s", rid, request.method, request.url.path)
        return JSONResponse(
            {"detail": "Internal server error", "request_id": rid}, status_code=500
        )

    ms = (time.perf_counter() - start) * 1000
    logger.info("%s %s -> %s %.0fms rid=%s", request.method, request.url.path, response.status_code, ms, rid)

    response.headers["X-Request-ID"] = rid
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "same-origin"
    if not request.url.path.startswith(DOC_PATHS):
        response.headers["Content-Security-Policy"] = CSP
    return response


app.include_router(router)
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))


@app.get("/", response_class=HTMLResponse, include_in_schema=False)
def home(request: Request):
    # Request is the first argument in current Starlette; the old
    # TemplateResponse("index.html", {"request": ...}) form is deprecated.
    return templates.TemplateResponse(request, "index.html", {"app_name": settings.app_name})