from fastapi import APIRouter


router = APIRouter(prefix="/reporting", tags=["reporting"])


@router.get("/", summary="Reporting module status")
async def reporting_index() -> dict[str, str]:
    return {"module": "reporting", "status": "ready for future features"}
