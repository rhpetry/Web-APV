from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file="../.env", env_ignore_empty=True, extra="ignore")

    API_V1_STR: str = "/api/v1"
    PROJECT_NAME: str = "Web APV"
    BASE_DIR: Path = Path(__file__).resolve().parents[2]
    TRIPLESTORE_STORAGE_DIR: Path = BASE_DIR / "data" / "triplestore"


settings = Settings()
