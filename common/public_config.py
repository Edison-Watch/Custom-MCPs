"""The public (secret-free) view of the effective config.

Behind ``Config.to_public_dict`` and therefore the ``config_show`` /
``config_get`` services, which are reachable over the authenticated HTTP
transport and MCP. It shows what the process is actually running with: YAML
layers, pydantic defaults and env-var overrides (``DEV_ENV=prod`` reads
``"prod"``).

Two layers keep secrets out, and both fail closed:

1. Top-level UPPERCASE fields are the env-sourced settings. Only those named in
   :data:`PUBLIC_ENV_FIELDS` are kept; any other uppercase field - including
   one added later without classifying it - is omitted. Lowercase fields are
   the nested YAML-backed models and are kept; undeclared extras are not.
2. Any key, at any depth, matching :data:`SECRET_FIELD_NAMES` is dropped
   (case-insensitively), so a secret hand-placed under a nested YAML key
   cannot leak either. The set is *derived*: every uppercase ``Config`` field
   not on the allowlist, plus :data:`_EXTRA_SECRET_NAMES`.

``features`` allows arbitrary extras, so ``FEATURES__ANYTHING=...`` in the
environment lands there; only boolean flags are shown.
"""

from typing import Any

from common.global_config import Config

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

# Secrets read straight from the environment rather than declared on Config
# (utils/llm/dspy_inference.py reads Langfuse's), dropped if they ever appear
# as a key in the YAML-backed config.
_EXTRA_SECRET_NAMES: frozenset[str] = frozenset({"LANGFUSE_SECRET_KEY"})

# Every credential-bearing name, matched by full key at any depth and
# case-insensitively (a lowercase YAML key such as ``openai_api_key`` still
# populates the field, since pydantic-settings is case_sensitive=False).
SECRET_FIELD_NAMES: frozenset[str] = (
    frozenset(name for name in Config.model_fields if name.isupper())
    - PUBLIC_ENV_FIELDS
) | _EXTRA_SECRET_NAMES

# Spellings an env override (always a string) may use for a boolean flag.
_BOOL_STRINGS: dict[str, bool] = {
    "true": True,
    "false": False,
    "1": True,
    "0": False,
    "yes": True,
    "no": False,
    "on": True,
    "off": False,
}


def public_dict(config: Config) -> dict[str, Any]:
    """Return the effective ``config`` with every secret removed."""
    dumped = config.model_dump(mode="json")
    # Only *declared* fields: with ``extra="allow"`` and
    # ``case_sensitive=False``, any undeclared ``.env`` key (e.g.
    # ``LANGFUSE_SECRET_KEY``) becomes a lowercase extra, which would
    # otherwise pass as a "nested model" and leak.
    declared = type(config).model_fields
    public = {
        name: value
        for name, value in dumped.items()
        if name in declared and (not name.isupper() or name in PUBLIC_ENV_FIELDS)
    }
    if isinstance(public.get("features"), dict):
        public["features"] = _public_feature_flags(public["features"])
    return _redact_secret_keys(public)


def _public_feature_flags(flags: dict[str, Any]) -> dict[str, bool]:
    """Keep only boolean feature flags; drop any other ``features`` extra.

    ``FeaturesConfig`` is ``extra="allow"`` so a flag can be added from the
    environment (``FEATURES__NEW_UI=true``), which also means any
    ``FEATURES__<NAME>=<value>`` - say a misplaced ``FEATURES__LANGFUSE_SECRET_KEY``
    - lands there. A flag is a boolean: an env-sourced one arrives as a string,
    so boolean spellings are shown coerced; anything else is omitted.
    """
    public: dict[str, bool] = {}
    for name, value in flags.items():
        if isinstance(value, bool):
            public[name] = value
        elif isinstance(value, str) and value.strip().lower() in _BOOL_STRINGS:
            public[name] = _BOOL_STRINGS[value.strip().lower()]
    return public


def _redact_secret_keys(value: Any) -> Any:
    """Recursively drop any dict key matching a secret field name.

    Removing the key (rather than masking its value) keeps the guarantee simple:
    a secret-named key never appears in the returned view at all.
    """
    if isinstance(value, dict):
        return {
            k: _redact_secret_keys(v)
            for k, v in value.items()
            if not (isinstance(k, str) and k.upper() in SECRET_FIELD_NAMES)
        }
    if isinstance(value, list):
        return [_redact_secret_keys(v) for v in value]
    return value
