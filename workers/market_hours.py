"""Market hours utility — all times converted to US Eastern."""
from datetime import datetime
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")


def now_et() -> datetime:
    return datetime.now(ET)


def is_weekday() -> bool:
    return now_et().weekday() < 5


def is_market_hours() -> bool:
    """9:30am - 4:00pm ET, Mon-Fri."""
    if not is_weekday():
        return False
    t = now_et()
    mins = t.hour * 60 + t.minute
    return 570 <= mins < 960


def is_pre_market() -> bool:
    """4:00am - 9:30am ET, Mon-Fri."""
    if not is_weekday():
        return False
    t = now_et()
    mins = t.hour * 60 + t.minute
    return 240 <= mins < 570


def is_after_hours() -> bool:
    """4:00pm - 8:00pm ET, Mon-Fri."""
    if not is_weekday():
        return False
    t = now_et()
    mins = t.hour * 60 + t.minute
    return 960 <= mins < 1200


def is_extended_hours() -> bool:
    """Any time price feeds should run — pre, regular, after."""
    return is_pre_market() or is_market_hours() or is_after_hours()
