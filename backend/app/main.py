from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.routing import APIRoute

from backend.app.api.main import api_router
from backend.app.api.routes import triplestore
from backend.app.config import settings


def custom_generate_unique_id(route: APIRoute) -> str:
    return f"{route.tags[0]}-{route.name}"


app = FastAPI(
    title=settings.PROJECT_NAME,
    openapi_url=f"{settings.API_V1_STR}/openapi.json",
    generate_unique_id_function=custom_generate_unique_id,
)

app.include_router(api_router, prefix=settings.API_V1_STR)


@app.get("/", response_class=HTMLResponse, tags=["root"])
async def read_root() -> str:
    return triplestore.get_home_page()
