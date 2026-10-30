"""Radar Replay: records Radar Map Manager's live stream to a rolling 48 h buffer.

Lives in its own integration (enabled with `rmm_replay:` in configuration.yaml) so
updating Radar Map Manager through HACS never removes it.
"""
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType

from .recorder import async_setup_recorder

DOMAIN = 'rmm_replay'
CONFIG_SCHEMA = cv.empty_config_schema(DOMAIN)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    await async_setup_recorder(hass)
    return True
