import os
import re
import warnings
from pathlib import Path
from typing import Any

import yaml
from dotenv import dotenv_values, load_dotenv
from loguru import logger
from pydantic import Field, model_validator
from pydantic_settings import (
    BaseSettings,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
)

# Import configuration models
from .config_models import (
    AgenticPaymentsConfig,
    AskConfig,
    BrandingConfig,
    CliConfig,
    DefaultLlm,
    ExampleParent,
    FeaturesConfig,
    GmailConfig,
    LlmConfig,
    LoggingConfig,
    RateLimitConfig,
    ServerConfig,
    SubscriptionConfig,
    TelemetryConfig,
    WebBotAuthConfig,
)

# Get the path to the root directory (one level up from common)
root_dir = Path(__file__).parent.parent

OPENAI_O_SERIES_PATTERN = r"o(\d+)(-mini)?"


# Custom YAML settings source
class YamlSettingsSource(PydanticBaseSettingsSource):
    """
    Custom settings source that loads from YAML files with priority:
    1. .global_config.yaml (highest priority, git-ignored)
    2. production_config.yaml (if DEV_ENV=prod)
    3. global_config.yaml (base config)
    """

    def __init__(self, settings_cls: type[BaseSettings]):
        super().__init__(settings_cls)
        self.yaml_data = self._load_yaml_files()

    def _load_yaml_files(self) -> dict[str, Any]:  # noqa: C901
        """Load and merge YAML configuration files."""

        def recursive_update(default: dict, override: dict) -> dict:
            """Recursively update nested dictionaries."""
            for key, value in override.items():
                if isinstance(value, dict) and isinstance(default.get(key), dict):
                    recursive_update(default[key], value)
                else:
                    default[key] = value
            return default

        # Load base config
        config_path = root_dir / "common" / "global_config.yaml"
        try:
            with open(config_path, "r") as file:
                config_data = yaml.safe_load(file) or {}
        except FileNotFoundError as e:
            raise RuntimeError(f"Required config file not found: {config_path}") from e
        except yaml.YAMLError as e:
            raise RuntimeError(f"Invalid YAML in {config_path}: {e}") from e

        # Load split YAML files from common/ directory
        reserved_filenames = {
            "global_config.yaml",
            "production_config.yaml",
            ".global_config.yaml",
        }
        common_dir = root_dir / "common"
        split_files = sorted(common_dir.glob("*.yaml"))
        for split_file in split_files:
            if split_file.name in reserved_filenames:
                continue
            # Security: skip symlinks to prevent loading files outside common/
            if split_file.is_symlink():
                logger.warning(f"Skipping symlink config file: {split_file}")
                continue
            root_key = split_file.stem
            if root_key in config_data:
                raise KeyError(
                    f"Config conflict: key '{root_key}' from '{split_file.name}' "
                    f"already exists in global_config.yaml. Remove it from one location."
                )
            try:
                with open(split_file, "r") as file:
                    split_data = yaml.safe_load(file)
                if split_data is not None:
                    config_data[root_key] = split_data
                    logger.debug(
                        f"Loaded split config: {split_file.name} -> '{root_key}'"
                    )
            except yaml.YAMLError as e:
                raise RuntimeError(f"Invalid YAML in {split_file}: {e}") from e

        # Load production config if in prod environment
        if os.getenv("DEV_ENV") == "prod":
            prod_config_path = root_dir / "common" / "production_config.yaml"
            if prod_config_path.exists():
                try:
                    with open(prod_config_path, "r") as file:
                        prod_config_data = yaml.safe_load(file)
                    if prod_config_data:
                        config_data = recursive_update(config_data, prod_config_data)
                        logger.warning(
                            "\033[33m❗️ Overwriting common/global_config.yaml with common/production_config.yaml\033[0m"
                        )
                except FileNotFoundError:
                    logger.warning(
                        f"Production config file not found: {prod_config_path}"
                    )
                except yaml.YAMLError as e:
                    raise RuntimeError(
                        f"Invalid YAML in {prod_config_path}: {e}"
                    ) from e

        # Load custom local config if it exists (highest priority)
        custom_config_path = root_dir / ".global_config.yaml"
        if custom_config_path.exists():
            try:
                with open(custom_config_path, "r") as file:
                    custom_config_data = yaml.safe_load(file)

                if custom_config_data:
                    config_data = recursive_update(config_data, custom_config_data)
                    warning_msg = "\033[33m❗️ Overwriting default common/global_config.yaml with .global_config.yaml\033[0m"
                    if config_data.get("logging", {}).get("verbose"):
                        warning_msg += f"\033[33mCustom .global_config.yaml values:\n---\n{yaml.dump(custom_config_data, default_flow_style=False)}\033[0m"
                    logger.warning(warning_msg)
            except FileNotFoundError:
                logger.warning(f"Custom config file not found: {custom_config_path}")
            except yaml.YAMLError as e:
                raise RuntimeError(f"Invalid YAML in {custom_config_path}: {e}") from e

        return config_data

    def get_field_value(self, field: Any, field_name: str) -> tuple[Any, str, bool]:
        """Get field value from YAML data."""
        field_value = self.yaml_data.get(field_name)
        return field_value, field_name, False

    def __call__(self) -> dict[str, Any]:
        """Return the complete YAML configuration."""
        return self.yaml_data


class Config(BaseSettings):
    """
    Global configuration using Pydantic Settings.
    Loads from:
    1. Environment variables (from .env or .prod.env)
    2. YAML files (global_config.yaml, production_config.yaml, .global_config.yaml)
    """

    model_config = SettingsConfigDict(
        # Load from .env file (will be handled separately for .prod.env)
        env_file=str(root_dir / ".env"),
        env_file_encoding="utf-8",
        # Allow nested env vars with double underscore
        env_nested_delimiter="__",
        # Case sensitive for field names
        case_sensitive=False,
        # Allow extra fields from YAML
        extra="allow",
    )

    # Top-level fields
    model_name: str
    dot_global_config_health_check: bool
    example_parent: ExampleParent
    default_llm: DefaultLlm
    llm_config: LlmConfig
    logging: LoggingConfig
    features: FeaturesConfig = Field(default_factory=lambda: FeaturesConfig())
    telemetry: TelemetryConfig = Field(default_factory=lambda: TelemetryConfig())
    cli: CliConfig = Field(default_factory=lambda: CliConfig())
    server: ServerConfig = Field(default_factory=lambda: ServerConfig())
    branding: BrandingConfig = Field(default_factory=lambda: BrandingConfig())
    subscription_config: SubscriptionConfig = Field(
        default_factory=lambda: SubscriptionConfig()
    )
    rate_limit: RateLimitConfig = Field(default_factory=lambda: RateLimitConfig())
    payments: AgenticPaymentsConfig = Field(
        default_factory=lambda: AgenticPaymentsConfig()
    )
    ask: AskConfig = Field(default_factory=lambda: AskConfig())
    web_bot_auth: WebBotAuthConfig = Field(default_factory=lambda: WebBotAuthConfig())
    gmail: GmailConfig = Field(default_factory=lambda: GmailConfig())

    # Environment variables
    DEV_ENV: str
    OPENAI_API_KEY: str | None = None
    ANTHROPIC_API_KEY: str | None = None
    GROQ_API_KEY: str | None = None
    PERPLEXITY_API_KEY: str | None = None
    GEMINI_API_KEY: str | None = None

    # Apify (Reddit scraper and any future Actor-backed services)
    APIFY_API_KEY: str | None = None
    # Optional override of the Reddit Actor slug (tilde form). When unset the
    # service uses its default; a mapped Actor id makes engagement counts flow
    # through with no code change (see services/reddit_svc.py).
    APIFY_ACTOR_ID: str | None = None

    # Agentic payments (observability only - the protocol reads these
    # via os.getenv() using the env var name from payments.yaml config,
    # not from these fields directly)
    X402_WALLET_ADDRESS: str | None = None
    X402_PRIVATE_KEY: str | None = None

    # Database & auth secrets
    BACKEND_DB_URI: str | None = None
    WORKOS_CLIENT_ID: str | None = None
    WORKOS_API_KEY: str | None = None
    # AuthKit issuer URL (https://<env>.authkit.app); enables OAuth 2.1 on /mcp
    WORKOS_AUTHKIT_DOMAIN: str | None = None
    # Canonical public URL of the /mcp endpoint (RFC 8707 resource identifier);
    # must match the resource indicator configured in the WorkOS dashboard
    MCP_PUBLIC_URL: str | None = None
    # Canonical public base URL of the HTTP API (no trailing slash, e.g.
    # https://api.example.com). When set, it is advertised as the `servers`
    # entry in the published OpenAPI spec so codegen / Swagger "Try it out" and
    # the landing-page API reference target the right host. Unset -> relative.
    API_PUBLIC_URL: str | None = None
    # Web Bot Auth signing identity: base64url-encoded 32-byte Ed25519 private
    # key seed. When set, /.well-known/http-message-signatures-directory
    # publishes the matching public key as a JWK Set; unset -> the route 404s.
    WEB_BOT_AUTH_PRIVATE_KEY: str | None = None
    SESSION_SECRET_KEY: str = "change-me-in-production"
    # Explicit opt-in for the unsigned ``{"sub": ...}`` test-mode auth token
    # (see api_server/auth/workos_auth.py). Defaults OFF so the bypass is never
    # live just because DEV_ENV is left at its "dev" default; a dev must both set
    # this AND keep DEV_ENV in {local,dev}. Never set in a networked deployment.
    ALLOW_TEST_TOKENS: bool = False

    # Stripe & billing
    STRIPE_SECRET_KEY: str | None = None
    STRIPE_TEST_SECRET_KEY: str | None = None
    STRIPE_WEBHOOK_SECRET: str | None = None
    STRIPE_TEST_WEBHOOK_SECRET: str | None = None
    STRIPE_ALLOW_LIVE_KEY_IN_DEV: bool = False
    FRONTEND_URL: str = "http://localhost:3000"

    # Redis
    REDIS_URL: str | None = None

    # Google OAuth (Gmail integration) - fill in real values in .env
    GOOGLE_CLIENT_ID: str | None = None
    GOOGLE_CLIENT_SECRET: str | None = None
    GOOGLE_REDIRECT_URI: str | None = None
    # Base64-url Fernet key used to encrypt stored refresh tokens
    GOOGLE_TOKEN_ENC_KEY: str | None = None

    # Gmail push notifications (Pub/Sub) + outbound webhook fan-out.
    # All optional; if GMAIL_PUBSUB_TOPIC is unset the push pipeline stays
    # dormant (no watch auto-start, no runner loop).
    # Fully-qualified Pub/Sub topic, e.g. "projects/<proj>/topics/<topic>".
    GMAIL_PUBSUB_TOPIC: str | None = None
    # OIDC "aud" claim the push receiver requires on the Pub/Sub JWT.
    GMAIL_PUSH_AUDIENCE: str | None = None
    # OIDC "email" claim the push receiver requires (the push subscription's
    # service account). Empty disables the identity check (dev only).
    GMAIL_PUSH_SA_EMAIL: str | None = None
    # How the periodic runner (watch renewal + outbox drain) is driven:
    #   "off"      - no runner (default)
    #   "loop"     - in-process asyncio loop started in the FastAPI lifespan
    #   "endpoint" - driven externally by POSTing the internal /renew route
    WEBHOOK_RUNNER_MODE: str = "off"
    # Seconds between in-process runner ticks when WEBHOOK_RUNNER_MODE="loop".
    WEBHOOK_RUNNER_INTERVAL_S: int = 30
    # Max delivery attempts before an outbox row is marked "failed".
    WEBHOOK_MAX_ATTEMPTS: int = 6
    # Shared bearer required by the internal POST /api/v1/google/internal/renew
    # endpoint (WEBHOOK_RUNNER_MODE="endpoint"). Unset -> endpoint disabled.
    WEBHOOK_RUNNER_TOKEN: str | None = None

    # Runtime environment (computed via default_factory)
    is_local: bool = Field(
        default_factory=lambda: os.getenv("GITHUB_ACTIONS") != "true"
    )
    running_on: str = Field(
        default_factory=lambda: (
            "🖥️  local" if os.getenv("GITHUB_ACTIONS") != "true" else "☁️  CI"
        )
    )

    @property
    def is_dev(self) -> bool:
        """True only for the two explicit development values.

        Fails secure: anything else - unset, ``staging``, ``prod``, or a typo -
        is treated as production, so a misspelled ``DEV_ENV`` can never relax a
        security control. This is the single owner of that predicate; callers
        must not re-derive it from ``DEV_ENV``.
        """
        return (self.DEV_ENV or "").lower() in {"local", "dev"}

    @model_validator(mode="after")
    def _require_secret_in_prod(self) -> "Config":
        if (
            self.DEV_ENV == "prod"
            and self.SESSION_SECRET_KEY == "change-me-in-production"
        ):
            raise ValueError(
                "SESSION_SECRET_KEY must be set to a strong random value in production"
            )
        return self

    @model_validator(mode="after")
    def _require_mcp_public_url_with_authkit(self) -> "Config":
        # Strip stray whitespace from .env values (it would break exact
        # issuer/audience matching) and normalize blank values to None so
        # they can't bypass the production check below.
        if self.WORKOS_AUTHKIT_DOMAIN is not None:
            self.WORKOS_AUTHKIT_DOMAIN = self.WORKOS_AUTHKIT_DOMAIN.strip() or None
        if self.MCP_PUBLIC_URL is not None:
            self.MCP_PUBLIC_URL = self.MCP_PUBLIC_URL.strip() or None
        # Same normalization for the API host: a trailing space would produce a
        # broken servers[0].url in the published OpenAPI spec.
        if self.API_PUBLIC_URL is not None:
            self.API_PUBLIC_URL = self.API_PUBLIC_URL.strip() or None
        # Tokens are audience-bound to MCP_PUBLIC_URL; without it the resource
        # URI falls back to localhost and OAuth silently breaks in production.
        if (
            self.DEV_ENV == "prod"
            and self.WORKOS_AUTHKIT_DOMAIN
            and not self.MCP_PUBLIC_URL
        ):
            raise ValueError(
                "MCP_PUBLIC_URL must be set when WORKOS_AUTHKIT_DOMAIN is "
                "enabled in production"
            )
        return self

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        """
        Customize the priority order of settings sources.
        Priority (highest to lowest):
        1. Environment variables
        2. .env file
        3. YAML files (custom .global_config.yaml > production_config.yaml > global_config.yaml)
        4. Init settings (passed to constructor)
        """
        yaml_source = YamlSettingsSource(settings_cls)
        return (
            env_settings,
            dotenv_settings,
            yaml_source,
            init_settings,
        )

    def to_dict(self) -> dict[str, Any]:
        """Convert config to dictionary.

        Includes environment-sourced fields (secrets). Internal use only - do
        NOT expose the result to any transport. Anything user-facing must use
        :meth:`to_public_dict`.
        """
        return self.model_dump()

    def to_public_dict(self) -> dict[str, Any]:
        """Return the *effective* config with every secret removed.

        This is the view behind the ``config_show`` / ``config_get`` services
        (reachable over the authenticated HTTP transport and MCP), so it shows
        what the process is actually running with: YAML layers, pydantic
        defaults and env-var overrides (``DEV_ENV=prod`` reads ``"prod"``).

        Two layers keep secrets out, and the first one fails closed:

        1. Top-level UPPERCASE fields are the env-sourced settings. Only those
           named in :data:`PUBLIC_ENV_FIELDS` are kept; any other uppercase
           field - including one added later without classifying it - is
           omitted. Lowercase fields are the nested YAML-backed models and are
           kept.
        2. Any key, at any depth, matching :data:`_SECRET_FIELD_NAMES` is
           dropped (case-insensitively), so a secret hand-placed under a nested
           YAML key cannot leak either.

        Every uppercase field must appear in exactly one of the two lists;
        ``tests/test_config_public_view.py`` enforces it.
        """
        dumped = self.model_dump(mode="json")
        public = {
            name: value
            for name, value in dumped.items()
            if not name.isupper() or name in PUBLIC_ENV_FIELDS
        }
        return _redact_secret_keys(public)

    def _identify_provider(self, model_name: str) -> str:
        """Identify the LLM provider from a model name string."""
        name_lower = model_name.lower()
        if "gpt" in name_lower or re.match(OPENAI_O_SERIES_PATTERN, name_lower):
            return "openai"
        if "claude" in name_lower or "anthropic" in name_lower:
            return "anthropic"
        if "groq" in name_lower:
            return "groq"
        if "perplexity" in name_lower:
            return "perplexity"
        if "gemini" in name_lower:
            return "gemini"
        return "unknown"

    def llm_api_key(self, model_name: str | None = None) -> str:
        """Returns the appropriate API key based on the model name."""
        model_identifier = model_name or self.model_name
        provider = self._identify_provider(model_identifier)
        api_keys = {
            "openai": self.OPENAI_API_KEY,
            "anthropic": self.ANTHROPIC_API_KEY,
            "groq": self.GROQ_API_KEY,
            "perplexity": self.PERPLEXITY_API_KEY,
            "gemini": self.GEMINI_API_KEY,
        }
        if provider in api_keys:
            key = api_keys[provider]
            if key is None:
                raise ValueError(
                    f"API key for provider '{provider}' is not configured. "
                    f"Set {provider.upper()}_API_KEY in your .env file."
                )
            return key
        raise ValueError(f"No API key configured for model: {model_identifier}")


# Env-sourced (UPPERCASE) Config fields that are safe to show through
# config_show / config_get: identifiers, public URLs, OAuth client ids, flags
# and tuning knobs. This is an allowlist - an uppercase field missing from it is
# omitted from the public view, so a new secret cannot leak by default.
PUBLIC_ENV_FIELDS: frozenset[str] = frozenset(
    {
        "DEV_ENV",
        "APIFY_ACTOR_ID",
        "X402_WALLET_ADDRESS",  # a public receiving address
        "WORKOS_CLIENT_ID",
        "WORKOS_AUTHKIT_DOMAIN",
        "MCP_PUBLIC_URL",
        "API_PUBLIC_URL",
        "ALLOW_TEST_TOKENS",
        "STRIPE_ALLOW_LIVE_KEY_IN_DEV",
        "FRONTEND_URL",
        "GOOGLE_CLIENT_ID",
        "GOOGLE_REDIRECT_URI",
        # Pub/Sub topic + OIDC audience/service-account the push receiver
        # checks: identifiers, not credentials (the JWT is Google-signed).
        "GMAIL_PUBSUB_TOPIC",
        "GMAIL_PUSH_AUDIENCE",
        "GMAIL_PUSH_SA_EMAIL",
        "WEBHOOK_RUNNER_MODE",
        "WEBHOOK_RUNNER_INTERVAL_S",
        "WEBHOOK_MAX_ATTEMPTS",
    }
)

# The credential-bearing (env-sourced) fields on Config, enumerated explicitly
# rather than by keyword heuristic (which both over-matched non-secret flags
# like STRIPE_ALLOW_LIVE_KEY_IN_DEV and missed names like REDIS_URL). Used to
# drop any key that collides with one of these names, at any depth, from the
# public view - the second layer behind PUBLIC_ENV_FIELDS, so a secret
# mistakenly placed under a nested YAML key (e.g. a hand-edited
# .global_config.yaml) can never leak through config_show / config_get.
# Non-secret env fields live in PUBLIC_ENV_FIELDS instead. Matched by full key name, case-insensitively (see
# _redact_secret_keys): substrings never match, but a lowercase spelling of a
# secret name such as ``openai_api_key`` is dropped at any depth.
_SECRET_FIELD_NAMES: frozenset[str] = frozenset(
    {
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "GROQ_API_KEY",
        "PERPLEXITY_API_KEY",
        "GEMINI_API_KEY",
        "APIFY_API_KEY",
        "X402_PRIVATE_KEY",
        "BACKEND_DB_URI",
        "REDIS_URL",
        "WORKOS_API_KEY",
        "WEB_BOT_AUTH_PRIVATE_KEY",
        "SESSION_SECRET_KEY",
        "STRIPE_SECRET_KEY",
        "STRIPE_TEST_SECRET_KEY",
        "STRIPE_WEBHOOK_SECRET",
        "STRIPE_TEST_WEBHOOK_SECRET",
        "GOOGLE_CLIENT_SECRET",
        "GOOGLE_TOKEN_ENC_KEY",
        "WEBHOOK_RUNNER_TOKEN",
    }
)


def _redact_secret_keys(value: Any) -> Any:
    """Recursively drop any dict key matching a secret field name.

    Removing the key (rather than masking its value) keeps the guarantee simple:
    a secret-named key never appears in the returned view at all.
    """
    if isinstance(value, dict):
        # Case-insensitive: pydantic-settings is case_sensitive=False, so a
        # lowercase YAML key like ``openai_api_key`` still populates the secret
        # field and must be dropped too.
        return {
            k: _redact_secret_keys(v)
            for k, v in value.items()
            if not (isinstance(k, str) and k.upper() in _SECRET_FIELD_NAMES)
        }
    if isinstance(value, list):
        return [_redact_secret_keys(v) for v in value]
    return value


# Load .env files before creating the config instance
# Load .env file first, to get DEV_ENV if it's defined there.
# override=False so real environment variables keep priority over .env,
# matching the source order documented in settings_customise_sources.
load_dotenv(dotenv_path=root_dir / ".env", override=False)

# Now, check DEV_ENV and load .prod.env if it's 'prod', overriding .env
if os.getenv("DEV_ENV") == "prod":
    load_dotenv(dotenv_path=root_dir / ".prod.env", override=True)

# Check if .env file has been properly loaded
is_local = os.getenv("GITHUB_ACTIONS") != "true"
if is_local:
    env_file_to_check = ".prod.env" if os.getenv("DEV_ENV") == "prod" else ".env"
    env_values = dotenv_values(root_dir / env_file_to_check)
    if not env_values:
        warnings.warn(
            f"{env_file_to_check} file not found or empty",
            UserWarning,
            stacklevel=2,
        )

# Create a singleton instance
# Note: Config() loads all required fields from YAML and .env files via custom settings sources
global_config = Config()  # ty: ignore[missing-argument]
