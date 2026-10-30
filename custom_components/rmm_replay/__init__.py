"""Radar Replay: records Radar Map Manager's live stream to a rolling 48 h buffer.

Lives in its own integration (enabled with `rmm_replay:` in configuration.yaml) so
updating Radar Map Manager through HACS never removes it.
"""
import voluptuous as vol

from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType

from .recorder import async_setup_recorder

DOMAIN = 'rmm_replay'
CONF_RADARS = 'radars'

# Optional per-radar naming, keyed by the radar's name in Radar Map Manager:
#   rmm_replay:
#     radars:
#       ld2450_tracker:
#         short: t1            # code stored in each frame (keep it short)
#         label: Bedroom radar # shown in the card's legend
#         color: "#FF8A80"     # legend, FOV cone and raw-dot colour
RADAR_SCHEMA = vol.Schema({
    vol.Optional('short'): cv.string,
    vol.Optional('label'): cv.string,
    vol.Optional('color'): cv.string,
})

CONFIG_SCHEMA = vol.Schema(
    {
        DOMAIN: vol.Any(
            None,
            vol.Schema({vol.Optional(CONF_RADARS, default={}): {cv.string: vol.Any(None, RADAR_SCHEMA)}}),
        )
    },
    extra=vol.ALLOW_EXTRA,
)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    conf = config.get(DOMAIN) or {}
    await async_setup_recorder(hass, conf.get(CONF_RADARS))
    return True
