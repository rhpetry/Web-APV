from fastapi import APIRouter

from backend.app.api.routes import reporting, triplestore


api_router = APIRouter()
api_router.include_router(triplestore.router)
api_router.include_router(reporting.router)
