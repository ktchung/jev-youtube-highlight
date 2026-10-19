from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=PROJECT_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    jev_api_key: SecretStr = SecretStr("")
    jev_model: str = Field(default="jev-1.14.0", min_length=1, max_length=120)
    jev_max_concurrency: int = Field(default=4, ge=1, le=16)
    jev_timeout_seconds: float = Field(default=45, ge=1, le=180)
    jev_input_cost_per_million: float = Field(default=0.042, ge=0, allow_inf_nan=False)
    jev_output_cost_per_million: float = Field(default=0, ge=0, allow_inf_nan=False)
    helper_port: int = Field(default=8765, ge=1024, le=65535)
    helper_cache_path: Path = PROJECT_ROOT / "data" / "cache.sqlite3"
    helper_allow_localhost_origins: bool = False
    helper_enable_ytdlp_fallback: bool = False

    @property
    def api_key_configured(self) -> bool:
        return bool(self.jev_api_key.get_secret_value().strip())
